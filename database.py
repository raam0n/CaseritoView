import json
from datetime import datetime
from typing import Any, Dict, List, Optional

import pandas as pd
from sqlalchemy import (
    Column,
    DateTime,
    Float,
    Index,
    Integer,
    String,
    Text,
    create_engine,
    func,
    inspect,
    text,
)
from sqlalchemy.orm import Session, declarative_base, sessionmaker

DATABASE_URL = "sqlite:///./caseritoview.db"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class PriceHistoryCache(Base):
    """
    Almacena ÚNICAMENTE datos diarios crudos ajustados (OHLCV) por ticker.
    Todos los indicadores técnicos se calculan on-the-fly en memoria con Pandas/NumPy.
    """

    __tablename__ = "price_history_cache"

    id = Column(Integer, primary_key=True, index=True)
    ticker = Column(String(32), index=True, nullable=False)
    date = Column(String(10), nullable=False)  # Formato YYYY-MM-DD
    open = Column(Float, nullable=False)
    high = Column(Float, nullable=False)
    low = Column(Float, nullable=False)
    close = Column(Float, nullable=False)
    volume = Column(Float, nullable=False)

    __table_args__ = (Index("ix_ticker_date", "ticker", "date", unique=True),)


class CacheMetadata(Base):
    """Controla la última fecha de verificación incremental por ticker."""

    __tablename__ = "cache_metadata"

    ticker = Column(String(32), primary_key=True, index=True)
    last_updated_date = Column(String(10), nullable=False)  # YYYY-MM-DD
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class TickerAnnotations(Base):
    """
    Almacena anotaciones por ticker:
    - Notas de texto libre (bitácora)
    - Líneas horizontales (soportes/resistencias)
    - Líneas de tendencia
    - Retrocesos de Fibonacci
    - Cajas de Medición (rango de precio / variación porcentual)
    """

    __tablename__ = "ticker_annotations"

    ticker = Column(String(32), primary_key=True, index=True)
    notes = Column(Text, default="", nullable=False)
    horizontals_json = Column(Text, default="[]", nullable=False)
    trendlines_json = Column(Text, default="[]", nullable=False)
    fibonaccis_json = Column(Text, default="[]", nullable=False)
    measures_json = Column(Text, default="[]", nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


def init_db() -> None:
    """
    Inicializa y migra automáticamente el esquema SQLite:
    - Si 'price_history_cache' tenía columnas viejas de indicadores (ema_50, etc.),
      la recrea limpia solo con datos crudos (open, high, low, close, volume).
    - Agrega columnas faltantes a 'ticker_annotations' (fibonaccis_json, measures_json) preservando dibujos.
    """
    inspector = inspect(engine)
    existing_tables = inspector.get_table_names()

    with engine.begin() as conn:
        if "price_history_cache" in existing_tables:
            cols = {c["name"] for c in inspector.get_columns("price_history_cache")}
            if "ema_50" in cols or "ema_200" in cols or "wma_200" in cols:
                conn.execute(text("DROP TABLE IF EXISTS price_history_cache"))
                conn.execute(text("DROP TABLE IF EXISTS cache_metadata"))

        if "ticker_annotations" in existing_tables:
            annot_cols = {c["name"] for c in inspector.get_columns("ticker_annotations")}
            if "fibonaccis_json" not in annot_cols:
                conn.execute(
                    text(
                        "ALTER TABLE ticker_annotations "
                        "ADD COLUMN fibonaccis_json TEXT NOT NULL DEFAULT '[]'"
                    )
                )
            if "measures_json" not in annot_cols:
                conn.execute(
                    text(
                        "ALTER TABLE ticker_annotations "
                        "ADD COLUMN measures_json TEXT NOT NULL DEFAULT '[]'"
                    )
                )

    Base.metadata.create_all(bind=engine)


def get_db():
    """Dependencia de FastAPI para obtener una sesión de base de datos."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# --- Funciones de Caché Histórico Crudo (OHLCV) ---


def get_max_cached_date(db: Session, ticker: str) -> Optional[str]:
    """Devuelve la fecha máxima ('YYYY-MM-DD') almacenada en SQLite para un ticker, o None si no hay datos."""
    ticker = ticker.upper()
    return (
        db.query(func.max(PriceHistoryCache.date))
        .filter(PriceHistoryCache.ticker == ticker)
        .scalar()
    )


def get_last_sync_date(db: Session, ticker: str) -> Optional[str]:
    """Devuelve la fecha ('YYYY-MM-DD') en que se consultó yfinance por última vez para este ticker."""
    ticker = ticker.upper()
    meta = db.query(CacheMetadata).filter(CacheMetadata.ticker == ticker).first()
    return meta.last_updated_date if meta else None


def mark_ticker_synced_today(db: Session, ticker: str, today_str: str) -> None:
    """Actualiza la marca de tiempo indicando que el ticker ya fue sincronizado hoy."""
    ticker = ticker.upper()
    meta = db.query(CacheMetadata).filter(CacheMetadata.ticker == ticker).first()
    if meta:
        meta.last_updated_date = today_str
        meta.updated_at = datetime.utcnow()
    else:
        meta = CacheMetadata(
            ticker=ticker,
            last_updated_date=today_str,
            updated_at=datetime.utcnow(),
        )
        db.add(meta)
    db.commit()


def upsert_raw_history(
    db: Session, ticker: str, records: List[Dict[str, Any]], today_str: str
) -> None:
    """
    Inserta o actualiza velas diarias crudas en SQLite.
    Si algunas fechas del tramo descargado ya existían (ej. actualización de la última vela),
    las reemplaza limpiamente sin duplicar registros.
    """
    ticker = ticker.upper()
    if not records:
        mark_ticker_synced_today(db, ticker, today_str)
        return

    min_date = min(r["date"] for r in records)
    db.query(PriceHistoryCache).filter(
        PriceHistoryCache.ticker == ticker,
        PriceHistoryCache.date >= min_date,
    ).delete(synchronize_session=False)

    objects = [
        PriceHistoryCache(
            ticker=ticker,
            date=rec["date"],
            open=rec["open"],
            high=rec["high"],
            low=rec["low"],
            close=rec["close"],
            volume=rec["volume"],
        )
        for rec in records
    ]
    db.bulk_save_objects(objects)
    mark_ticker_synced_today(db, ticker, today_str)


def clear_ticker_history(db: Session, ticker: str) -> None:
    """
    Borra ÚNICAMENTE el historial de precios crudos y metadatos de caché de un ticker
    (para el Full Sync anti-splits/dividendos), preservando intactas las anotaciones del usuario.
    """
    ticker = ticker.upper()
    db.query(PriceHistoryCache).filter(PriceHistoryCache.ticker == ticker).delete(
        synchronize_session=False
    )
    db.query(CacheMetadata).filter(CacheMetadata.ticker == ticker).delete(
        synchronize_session=False
    )
    db.commit()


def get_raw_history_df(db: Session, ticker: str) -> pd.DataFrame:
    """
    Lee el historial diario crudo de SQLite y lo devuelve como un DataFrame de Pandas
    indexado por fecha (DatetimeIndex) con columnas ['Open', 'High', 'Low', 'Close', 'Volume'].
    """
    ticker = ticker.upper()
    rows = (
        db.query(PriceHistoryCache)
        .filter(PriceHistoryCache.ticker == ticker)
        .order_by(PriceHistoryCache.date.asc())
        .all()
    )
    if not rows:
        return pd.DataFrame()

    data = [
        {
            "Date": r.date,
            "Open": float(r.open),
            "High": float(r.high),
            "Low": float(r.low),
            "Close": float(r.close),
            "Volume": float(r.volume),
        }
        for r in rows
    ]
    df = pd.DataFrame(data)
    df["Date"] = pd.to_datetime(df["Date"])
    df = df.set_index("Date").sort_index()
    return df


# --- Funciones de Anotaciones (Notas, Horizontales, Tendencias y Fibonacci) ---


def get_ticker_annotations(db: Session, ticker: str) -> Dict[str, Any]:
    """Obtiene todas las anotaciones persistidas de un ticker."""
    ticker = ticker.upper()
    row = db.query(TickerAnnotations).filter(TickerAnnotations.ticker == ticker).first()
    if not row:
        return {
            "ticker": ticker,
            "notes": "",
            "horizontals": [],
            "trendlines": [],
            "fibonaccis": [],
            "measures": [],
        }

    def _safe_load(raw_json: Optional[str]) -> List[Dict[str, Any]]:
        try:
            return json.loads(raw_json or "[]")
        except json.JSONDecodeError:
            return []

    return {
        "ticker": ticker,
        "notes": row.notes or "",
        "horizontals": _safe_load(row.horizontals_json),
        "trendlines": _safe_load(row.trendlines_json),
        "fibonaccis": _safe_load(getattr(row, "fibonaccis_json", "[]")),
        "measures": _safe_load(getattr(row, "measures_json", "[]")),
    }


def save_ticker_annotations(
    db: Session,
    ticker: str,
    notes: str,
    horizontals: List[Dict[str, Any]],
    trendlines: List[Dict[str, Any]],
    fibonaccis: List[Dict[str, Any]],
    measures: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Guarda o actualiza notas, horizontales, líneas de tendencia, retrocesos de Fibonacci y mediciones en SQLite."""
    ticker = ticker.upper()
    row = db.query(TickerAnnotations).filter(TickerAnnotations.ticker == ticker).first()

    if measures is None:
        measures = []

    horizontals_str = json.dumps(horizontals, ensure_ascii=False)
    trendlines_str = json.dumps(trendlines, ensure_ascii=False)
    fibonaccis_str = json.dumps(fibonaccis, ensure_ascii=False)
    measures_str = json.dumps(measures, ensure_ascii=False)

    if row:
        row.notes = notes
        row.horizontals_json = horizontals_str
        row.trendlines_json = trendlines_str
        row.fibonaccis_json = fibonaccis_str
        row.measures_json = measures_str
        row.updated_at = datetime.utcnow()
    else:
        row = TickerAnnotations(
            ticker=ticker,
            notes=notes,
            horizontals_json=horizontals_str,
            trendlines_json=trendlines_str,
            fibonaccis_json=fibonaccis_str,
            measures_json=measures_str,
            updated_at=datetime.utcnow(),
        )
        db.add(row)

    db.commit()
    return {
        "ticker": ticker,
        "notes": notes,
        "horizontals": horizontals,
        "trendlines": trendlines,
        "fibonaccis": fibonaccis,
        "measures": measures,
    }
