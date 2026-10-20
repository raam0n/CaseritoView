from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

import numpy as np
import pandas as pd
import yfinance as yf
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database import (
    clear_ticker_history,
    get_db,
    get_last_sync_date,
    get_max_cached_date,
    get_raw_history_df,
    get_ticker_annotations,
    init_db,
    mark_ticker_synced_today,
    save_ticker_annotations,
    upsert_raw_history,
)

BASE_DIR = Path(__file__).resolve().parent

# Watchlist de 19 activos que cotizan en NYSE / NASDAQ (ordenados alfabéticamente)
DEFAULT_TICKERS: List[str] = sorted(
    [
        "AMZN",
        "ARM",
        "ASML",
        "BMA",
        "CRWV",
        "GGAL",
        "GOOGL",
        "HUT",
        "IREN",
        "KEEL",
        "MU",
        "NBIS",
        "NVDA",
        "ORCL",
        "PANW",
        "SNDK",
        "SPCX",
        "TSLA",
        "YPF",
    ]
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="CaseritoView Pro API",
    description="Servidor local de Análisis Técnico con Multi-Timeframe, Caché Incremental SQLite e Indicadores On-The-Fly",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Esquemas Pydantic para Anotaciones ---


class HorizontalLine(BaseModel):
    id: str
    price: float
    color: str = "#f59e0b"
    title: str = "S/R"


class TrendLine(BaseModel):
    id: str
    time1: str
    price1: float
    time2: str
    price2: float
    color: str = "#22c55e"


class FibonacciRetracement(BaseModel):
    id: str
    time1: str
    price1: float
    time2: str
    price2: float
    color: str = "#eab308"


class PriceMeasure(BaseModel):
    id: str
    time1: str
    price1: float
    time2: str
    price2: float
    color: str = "#22c55e"


class AnnotationsPayload(BaseModel):
    notes: str = ""
    horizontals: List[HorizontalLine] = Field(default_factory=list)
    trendlines: List[TrendLine] = Field(default_factory=list)
    fibonaccis: List[FibonacciRetracement] = Field(default_factory=list)
    measures: List[PriceMeasure] = Field(default_factory=list)


# --- Helpers de Descarga y Normalización de yfinance ---


def _is_valid_number(val: Any) -> bool:
    if val is None or pd.isna(val):
        return False
    try:
        f = float(val)
        return not (np.isnan(f) or np.isinf(f))
    except (TypeError, ValueError):
        return False


def _clean_float(val: Any) -> Optional[float]:
    if not _is_valid_number(val):
        return None
    return round(float(val), 4)


def _df_to_raw_records(raw_df: pd.DataFrame) -> List[Dict[str, Any]]:
    """Convierte un DataFrame descargado de yfinance en registros crudos OHLCV limpios."""
    if raw_df is None or raw_df.empty:
        return []

    df = raw_df.copy()
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    required = ["Open", "High", "Low", "Close"]
    for col in required:
        if col not in df.columns:
            return []

    df = df.dropna(subset=required).sort_index()
    records: List[Dict[str, Any]] = []

    for idx, row in df.iterrows():
        o = _clean_float(row["Open"])
        h = _clean_float(row["High"])
        l = _clean_float(row["Low"])
        c = _clean_float(row["Close"])
        if o is None or h is None or l is None or c is None:
            continue
        vol = float(row["Volume"]) if _is_valid_number(row.get("Volume", 0.0)) else 0.0
        records.append(
            {
                "date": pd.Timestamp(idx).strftime("%Y-%m-%d"),
                "open": o,
                "high": h,
                "low": l,
                "close": c,
                "volume": round(vol, 2),
            }
        )
    return records


def download_full_10y(ticker: str) -> List[Dict[str, Any]]:
    """Descarga hasta 10 años de datos diarios ajustados (auto_adjust=True) desde yfinance."""
    try:
        raw_df = yf.download(
            ticker,
            period="10y",
            interval="1d",
            auto_adjust=True,
            progress=False,
            threads=False,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Error al consultar yfinance para '{ticker}': {exc}",
        ) from exc

    return _df_to_raw_records(raw_df)


def sync_ticker_incremental(
    db: Session, ticker: str, force_check: bool = False
) -> str:
    """
    Asegura que SQLite tenga la historia diaria cruda actualizada para `ticker`:
    - Si no hay registros en SQLite, descarga 10 años completos (auto_adjust=True).
    - Si ya hay registros, consulta MAX(date); si faltan días hábiles hasta hoy,
      descarga únicamente el tramo incremental desde MAX(date) hasta hoy.
    """
    ticker = ticker.upper()
    today_str = date.today().isoformat()
    max_date = get_max_cached_date(db, ticker)

    # 1. Primera descarga: 10 años profundos
    if max_date is None:
        records = download_full_10y(ticker)
        if not records:
            raise HTTPException(
                status_code=404,
                detail=f"No se encontraron datos históricos en Yahoo Finance para '{ticker}'.",
            )
        upsert_raw_history(db, ticker, records, today_str)
        return "initial_10y"

    # 2. Verificar si necesitamos actualización incremental
    last_sync = get_last_sync_date(db, ticker)
    has_missing_business_days = len(pd.bdate_range(start=max_date, end=today_str)) > 1

    if not force_check and last_sync == today_str and not has_missing_business_days:
        return "cached"

    if max_date < today_str or force_check:
        try:
            # Descargamos desde max_date para refrescar el último cierre y sumar las ruedas nuevas
            inc_df = yf.download(
                ticker,
                start=max_date,
                interval="1d",
                auto_adjust=True,
                progress=False,
                threads=False,
            )
            inc_records = _df_to_raw_records(inc_df)
            if inc_records:
                upsert_raw_history(db, ticker, inc_records, today_str)
                return "incremental"
        except Exception:
            # Si falla la red en incremental pero tenemos datos en SQLite, operamos offline con el caché
            pass

    mark_ticker_synced_today(db, ticker, today_str)
    return "cached"


# --- Resample Multi-Timeframe y Cálculo de Indicadores On-The-Fly ---


def resample_timeframe(
    df_daily: pd.DataFrame, timeframe: Literal["1D", "1W", "1M"]
) -> pd.DataFrame:
    """Convierte el DataFrame diario en Semanal ('W-FRI') o Mensual ('ME') si corresponde."""
    if df_daily.empty or timeframe == "1D":
        return df_daily.copy()

    agg_rules = {
        "Open": "first",
        "High": "max",
        "Low": "min",
        "Close": "last",
        "Volume": "sum",
    }

    if timeframe == "1W":
        resampled = df_daily.resample("W-FRI").agg(agg_rules)
    elif timeframe == "1M":
        try:
            resampled = df_daily.resample("ME").agg(agg_rules)
        except ValueError:
            resampled = df_daily.resample("M").agg(agg_rules)
    else:
        resampled = df_daily.copy()

    return resampled.dropna(subset=["Close"]).sort_index()


def compute_indicators_on_the_fly(df: pd.DataFrame) -> pd.DataFrame:
    """
    Calcula en memoria sobre el DataFrame (1D, 1W o 1M):
    - EMA_9, EMA_21, EMA_50, EMA_100, EMA_200
    - SMA_200 (simple de 200 períodos)
    - WMA_200 (ponderada de 200 períodos)
    - RSI_14 (suavizado exacto de Wilder: alpha=1/14, min_periods=14, adjust=False)
    """
    df = df.copy()
    if df.empty:
        return df

    close = df["Close"].astype(float)

    # 1-5. EMAs de 9, 21, 50, 100 y 200 períodos + SMA de 200 períodos
    df["EMA_9"] = close.ewm(span=9, adjust=False).mean()
    df["EMA_21"] = close.ewm(span=21, adjust=False).mean()
    df["EMA_50"] = close.ewm(span=50, adjust=False).mean()
    df["EMA_100"] = close.ewm(span=100, adjust=False).mean()
    df["EMA_200"] = close.ewm(span=200, adjust=False).mean()
    df["SMA_200"] = close.rolling(window=200).mean()

    # 5. WMA 200 (Media móvil ponderada de 200 períodos)
    if len(close) >= 200:
        weights_200 = np.arange(1, 201, dtype=float)
        weights_sum = float(weights_200.sum())
        df["WMA_200"] = close.rolling(window=200).apply(
            lambda x: float(np.dot(x, weights_200) / weights_sum),
            raw=True,
        )
    else:
        df["WMA_200"] = np.nan

    # 6. RSI 14 con suavizado exacto de Wilder (alpha=1/14, min_periods=14, adjust=False)
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)

    avg_gain = gain.ewm(alpha=1.0 / 14.0, min_periods=14, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1.0 / 14.0, min_periods=14, adjust=False).mean()

    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    rsi = 100.0 - (100.0 / (1.0 + rs))
    rsi = np.where((avg_loss == 0.0) & (avg_gain > 0.0), 100.0, rsi)
    rsi = np.where((avg_loss == 0.0) & (avg_gain == 0.0), 50.0, rsi)

    df["RSI_14"] = pd.Series(rsi, index=df.index).where(avg_gain.notna())

    return df


def _extract_indicator_series(df: pd.DataFrame, col_name: str) -> List[Dict[str, Any]]:
    """
    Filtra estrictamente valores NaN/null/inf para que Lightweight Charts reciba
    únicamente objetos válidos {"time": "YYYY-MM-DD", "value": float}.
    """
    if col_name not in df.columns or df.empty:
        return []

    series_out: List[Dict[str, Any]] = []
    for idx, val in df[col_name].items():
        cleaned = _clean_float(val)
        if cleaned is not None:
            series_out.append(
                {
                    "time": pd.Timestamp(idx).strftime("%Y-%m-%d"),
                    "value": cleaned,
                }
            )
    return series_out


# --- Endpoints de la API ---


@app.get("/api/tickers")
def list_tickers() -> List[str]:
    """Devuelve los 19 tickers de seguimiento configurados en el backend."""
    return DEFAULT_TICKERS


@app.get("/api/history/{ticker}")
def get_history(
    ticker: str,
    timeframe: Literal["1D", "1W", "1M"] = Query(
        "1D", description="Temporalidad del gráfico: 1D (Diario), 1W (Semanal), 1M (Mensual)"
    ),
    force: bool = Query(
        False, description="Forzar verificación incremental contra yfinance"
    ),
    db: Session = Depends(get_db),
):
    """
    Devuelve las velas y los indicadores calculados on-the-fly para el ticker y temporalidad solicitados.
    Garantiza que ningún array de indicador contenga NaN ni null.
    """
    ticker_clean = ticker.strip().upper()
    sync_status = sync_ticker_incremental(db, ticker_clean, force_check=force)

    df_daily = get_raw_history_df(db, ticker_clean)
    if df_daily.empty:
        raise HTTPException(
            status_code=404,
            detail=f"No hay datos históricos disponibles para '{ticker_clean}'.",
        )

    df_tf = resample_timeframe(df_daily, timeframe)
    df_calc = compute_indicators_on_the_fly(df_tf)

    candles: List[Dict[str, Any]] = []
    bars_detail: List[Dict[str, Any]] = []

    for idx, row in df_calc.iterrows():
        o = _clean_float(row["Open"])
        h = _clean_float(row["High"])
        l = _clean_float(row["Low"])
        c = _clean_float(row["Close"])
        if o is None or h is None or l is None or c is None:
            continue

        time_str = pd.Timestamp(idx).strftime("%Y-%m-%d")
        vol = float(row["Volume"]) if _is_valid_number(row.get("Volume", 0.0)) else 0.0

        candles.append(
            {
                "time": time_str,
                "open": o,
                "high": h,
                "low": l,
                "close": c,
                "volume": round(vol, 2),
            }
        )

        bars_detail.append(
            {
                "time": time_str,
                "open": o,
                "high": h,
                "low": l,
                "close": c,
                "volume": round(vol, 2),
                "ema_9": _clean_float(row.get("EMA_9")),
                "ema_21": _clean_float(row.get("EMA_21")),
                "ema_50": _clean_float(row.get("EMA_50")),
                "ema_100": _clean_float(row.get("EMA_100")),
                "ema_200": _clean_float(row.get("EMA_200")),
                "sma_200": _clean_float(row.get("SMA_200")),
                "wma_200": _clean_float(row.get("WMA_200")),
                "rsi_14": _clean_float(row.get("RSI_14")),
            }
        )

    ema100_series = _extract_indicator_series(df_calc, "EMA_100")
    sma200_series = _extract_indicator_series(df_calc, "SMA_200")

    indicators = {
        "ema9": _extract_indicator_series(df_calc, "EMA_9"),
        "ema21": _extract_indicator_series(df_calc, "EMA_21"),
        "ema50": _extract_indicator_series(df_calc, "EMA_50"),
        "ema100": ema100_series,
        "ema200": _extract_indicator_series(df_calc, "EMA_200"),
        "sma200": sma200_series,
        "wma200": _extract_indicator_series(df_calc, "WMA_200"),
        "rsi14": _extract_indicator_series(df_calc, "RSI_14"),
    }

    return {
        "ticker": ticker_clean,
        "timeframe": timeframe,
        "sync_status": sync_status,
        "cached": sync_status == "cached",
        "max_date": get_max_cached_date(db, ticker_clean),
        "candles": candles,
        "ema100": ema100_series,
        "sma200": sma200_series,
        "indicators": indicators,
        "data": bars_detail,
    }


@app.post("/api/sync/{ticker}")
def full_sync_ticker(ticker: str, db: Session = Depends(get_db)):
    """
    Endpoint de 'Full Sync' (Anti-Splits/Dividendos):
    Elimina únicamente el historial de precios crudos de ese ticker en SQLite y vuelve
    a descargar los 10 años limpios desde cero con auto_adjust=True, manteniendo intactas
    las anotaciones, dibujos y notas del usuario.
    """
    ticker_clean = ticker.strip().upper()
    records = download_full_10y(ticker_clean)
    if not records:
        raise HTTPException(
            status_code=404,
            detail=f"No se pudieron descargar datos desde yfinance para '{ticker_clean}'.",
        )

    clear_ticker_history(db, ticker_clean)
    today_str = date.today().isoformat()
    upsert_raw_history(db, ticker_clean, records, today_str)

    return {
        "status": "ok",
        "ticker": ticker_clean,
        "bars_synced": len(records),
        "from_date": records[0]["date"],
        "to_date": records[-1]["date"],
    }


@app.get("/api/annotations/{ticker}")
def read_annotations(ticker: str, db: Session = Depends(get_db)):
    """Obtiene las notas, líneas horizontales, líneas de tendencia y retrocesos de Fibonacci del ticker."""
    return get_ticker_annotations(db, ticker)


@app.post("/api/annotations/{ticker}")
def write_annotations(
    ticker: str,
    payload: AnnotationsPayload,
    db: Session = Depends(get_db),
):
    """Guarda las notas, líneas horizontales, líneas de tendencia, retrocesos de Fibonacci y mediciones en SQLite."""
    horizontals_data = [h.model_dump() for h in payload.horizontals]
    trendlines_data = [t.model_dump() for t in payload.trendlines]
    fibonaccis_data = [f.model_dump() for f in payload.fibonaccis]
    measures_data = [m.model_dump() for m in payload.measures]
    return save_ticker_annotations(
        db=db,
        ticker=ticker,
        notes=payload.notes,
        horizontals=horizontals_data,
        trendlines=trendlines_data,
        fibonaccis=fibonaccis_data,
        measures=measures_data,
    )


# --- Rutas para servir el Frontend directamente desde FastAPI ---


@app.get("/")
def serve_index():
    return FileResponse(BASE_DIR / "index.html")


@app.get("/styles.css")
def serve_css():
    return FileResponse(BASE_DIR / "styles.css", media_type="text/css")


@app.get("/app.js")
def serve_js():
    return FileResponse(BASE_DIR / "app.js", media_type="application/javascript")
