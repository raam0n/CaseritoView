/**
 * CaseritoView Pro — Frontend de Análisis Técnico Local con Lightweight Charts
 * Soporta Multi-Timeframe (1D, 1W, 1M), Indicadores On-The-Fly, Sub-gráfico RSI (14) sincronizado,
 * Líneas Horizontales, Líneas de Tendencia y Retrocesos de Fibonacci persistidos en SQLite.
 */

const API_BASE =
  window.location.protocol === "file:" ||
  (window.location.port && window.location.port !== "8000")
    ? "http://127.0.0.1:8000"
    : "";

const FIB_RATIOS = [0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];

// --- Estado Global de la Aplicación ---
const state = {
  tickers: [],
  tickerSearchQuery: "",
  activeTicker: null,
  timeframe: "1D", // "1D" | "1W" | "1M"
  drawingMode: "cursor", // "cursor" | "trendline" | "horizontal" | "fibonacci" | "measure"
  pendingPoint: null, // { time, price } cuando se hizo el 1er click de Tendencia, Fib o Medición
  previewMouseEnd: null, // { time, price } actual del cursor durante trazado
  historyData: [],
  historyByTime: new Map(),
  timelineDates: [],
  annotations: {
    notes: "",
    horizontals: [], // [{ id, price, color, title }]
    trendlines: [], // [{ id, time1, price1, time2, price2, color }]
    fibonaccis: [], // [{ id, time1, price1, time2, price2, color }]
    measures: [], // [{ id, time1, price1, time2, price2, color }]
  },
  selectedDrawing: null, // { type: "horizontal" | "trendline" | "fibonacci" | "measure", id: string }
  dragging: null,
};

// --- Referencias a Lightweight Charts ---
let chart = null;
let mainAlignSeries = null; // Serie whitespace invisible para proyectar fechas futuras a la derecha
let candleSeries = null;
let ema9Series = null;
let ema21Series = null;
let ema50Series = null;
let ema100Series = null;
let ema200Series = null;
let sma200Series = null;
let wma200Series = null;

let rsiChart = null;
let rsiAlignSeries = null; // Serie invisible para alinear 1:1 los índices lógicos con el gráfico principal
let rsiSeries = null;

let isSyncingRange = false;
let isSyncingCrosshair = false;

// Mapa de objetos PriceLine de soportes/resistencias horizontales en el gráfico principal
const priceLineRefs = new Map(); // id -> IPriceLine

// --- Referencias al DOM ---
const elSidebar = document.getElementById("app-sidebar");
const elWatchlistSection = document.getElementById("watchlist-section");
const elDrawingsSection = document.getElementById("drawings-section");
const elNotesSection = document.getElementById("notes-section");
const elResizerWatchlist = document.getElementById("resizer-watchlist");
const elResizerDrawings = document.getElementById("resizer-drawings");
const elSidebarWidthResizer = document.getElementById("sidebar-width-resizer");
const elTickerSearchInput = document.getElementById("ticker-search-input");
const elBtnClearSearch = document.getElementById("btn-clear-search");
const elTickerList = document.getElementById("ticker-list");
const elCustomTickerForm = document.getElementById("custom-ticker-form");
const elCustomTickerInput = document.getElementById("custom-ticker-input");
const elActiveTickerTitle = document.getElementById("active-ticker-title");
const elNotesTickerLabel = document.getElementById("notes-ticker-label");
const elCacheBadge = document.getElementById("cache-badge");
const elTickerNotes = document.getElementById("ticker-notes");
const elBtnSaveNotes = document.getElementById("btn-save-notes");
const elSaveStatus = document.getElementById("save-status");
const elDrawingsList = document.getElementById("drawings-list");
const elDrawingsCount = document.getElementById("drawings-count");
const elChartContainer = document.getElementById("chart-container");
const elRsiChartContainer = document.getElementById("rsi-chart-container");
const elHandlesOverlay = document.getElementById("handles-overlay");
const elLegendOhlc = document.getElementById("legend-ohlc");
const elLegendRsiValue = document.getElementById("legend-rsi-value");
const elDrawingHint = document.getElementById("drawing-hint");

const elSelectedBar = document.getElementById("selected-drawing-bar");
const elSelectedType = document.getElementById("selected-drawing-type");
const elColorPicker = document.getElementById("drawing-color-picker");
const elEditHorizFields = document.getElementById("edit-horizontal-fields");
const elEditHorizPrice = document.getElementById("edit-horiz-price");
const elEditHorizTitle = document.getElementById("edit-horiz-title");
const elEditTrendFields = document.getElementById("edit-trendline-fields");
const elEditTrendP1 = document.getElementById("edit-trend-p1");
const elEditTrendP2 = document.getElementById("edit-trend-p2");
const btnDeleteSelected = document.getElementById("btn-delete-selected");
const btnCloseSelected = document.getElementById("btn-close-selected");

const btnModeCursor = document.getElementById("btn-mode-cursor");
const btnModeTrendline = document.getElementById("btn-mode-trendline");
const btnModeHorizontal = document.getElementById("btn-mode-horizontal");
const btnModeFibonacci = document.getElementById("btn-mode-fibonacci");
const btnModeMeasure = document.getElementById("btn-mode-measure");
const btnClearAll = document.getElementById("btn-clear-all");
const btnFullSync = document.getElementById("btn-full-sync");

const btnPresetSwing = document.getElementById("btn-preset-swing");
const btnPresetPositional = document.getElementById("btn-preset-positional");

const toggleEma9 = document.getElementById("toggle-ema9");
const toggleEma21 = document.getElementById("toggle-ema21");
const toggleEma50 = document.getElementById("toggle-ema50");
const toggleEma100 = document.getElementById("toggle-ema100");
const toggleEma200 = document.getElementById("toggle-ema200");
const toggleSma200 = document.getElementById("toggle-sma200");
const toggleWma200 = document.getElementById("toggle-wma200");

let notesDebounceTimer = null;

// ============================================================================
// 1. INICIALIZACIÓN DE GRÁFICOS (PRINCIPAL + RSI 14 SINCRONIZADO)
// ============================================================================

const COMMON_HANDLE_SCALE = {
  mouseWheel: true,
  pinch: false,
  axisPressedMouseMove: {
    time: false,
    price: false,
  },
  axisDoubleClickReset: {
    time: true,
    price: true,
  },
};

function initCharts() {
  // --- A. Gráfico Principal (Velas + Medias Móviles) ---
  chart = LightweightCharts.createChart(elChartContainer, {
    layout: {
      background: { type: "solid", color: "#131722" },
      textColor: "#d1d4dc",
    },
    grid: {
      vertLines: { color: "#1f2430" },
      horzLines: { color: "#1f2430" },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: {
        width: 1,
        color: "#758696",
        style: LightweightCharts.LineStyle.Dashed,
      },
      horzLine: {
        width: 1,
        color: "#758696",
        style: LightweightCharts.LineStyle.Dashed,
      },
    },
    rightPriceScale: {
      borderColor: "#2a2e39",
      scaleMargins: { top: 0.08, bottom: 0.08 },
      autoScale: true,
      minimumWidth: 72,
    },
    timeScale: {
      borderColor: "#2a2e39",
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 25,
    },
    handleScale: COMMON_HANDLE_SCALE,
  });

  // Serie fantasma (whitespace) en el gráfico principal para habilitar coordenadas de tiempo a la derecha de la última vela
  mainAlignSeries = chart.addLineSeries({
    color: "transparent",
    lineVisible: false,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
    autoscaleInfoProvider: () => null,
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: "#26a69a",
    downColor: "#ef5350",
    borderVisible: false,
    wickUpColor: "#26a69a",
    wickDownColor: "#ef5350",
  });

  ema9Series = chart.addLineSeries({
    color: "#38bdf8",
    lineWidth: 1.8,
    title: "EMA 9",
    priceLineVisible: false,
    lastValueVisible: true,
    crosshairMarkerVisible: false,
  });

  ema21Series = chart.addLineSeries({
    color: "#22c55e",
    lineWidth: 1.8,
    title: "EMA 21",
    priceLineVisible: false,
    lastValueVisible: true,
    crosshairMarkerVisible: false,
  });

  ema50Series = chart.addLineSeries({
    color: "#2962ff",
    lineWidth: 2,
    title: "EMA 50",
    priceLineVisible: false,
    lastValueVisible: true,
    crosshairMarkerVisible: false,
  });

  ema100Series = chart.addLineSeries({
    color: "#00E5FF",
    lineWidth: 2,
    title: "EMA 100",
    priceLineVisible: false,
    lastValueVisible: true,
    crosshairMarkerVisible: false,
    visible: toggleEma100 ? toggleEma100.checked : true,
  });

  ema200Series = chart.addLineSeries({
    color: "#ef4444",
    lineWidth: 2,
    title: "EMA 200",
    priceLineVisible: false,
    lastValueVisible: true,
    crosshairMarkerVisible: false,
  });

  sma200Series = chart.addLineSeries({
    color: "#E0E0E0",
    lineWidth: 2,
    title: "SMA 200",
    priceLineVisible: false,
    lastValueVisible: true,
    crosshairMarkerVisible: false,
    visible: toggleSma200 ? toggleSma200.checked : true,
  });

  wma200Series = chart.addLineSeries({
    color: "#f59e0b",
    lineWidth: 2,
    title: "WMA 200",
    priceLineVisible: false,
    lastValueVisible: true,
    crosshairMarkerVisible: false,
  });

  // --- B. Sub-gráfico de RSI (14, Wilder) ---
  rsiChart = LightweightCharts.createChart(elRsiChartContainer, {
    layout: {
      background: { type: "solid", color: "#131722" },
      textColor: "#d1d4dc",
    },
    grid: {
      vertLines: { color: "#1f2430" },
      horzLines: { color: "#1f2430" },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: {
        width: 1,
        color: "#758696",
        style: LightweightCharts.LineStyle.Dashed,
      },
      horzLine: {
        width: 1,
        color: "#758696",
        style: LightweightCharts.LineStyle.Dashed,
      },
    },
    rightPriceScale: {
      borderColor: "#2a2e39",
      scaleMargins: { top: 0.1, bottom: 0.1 },
      autoScale: true,
      minimumWidth: 72,
    },
    timeScale: {
      borderColor: "#2a2e39",
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 25,
    },
    handleScale: COMMON_HANDLE_SCALE,
  });

  // Serie fantasma (whitespace) para que rsiChart tenga exactamente el mismo eje temporal que chart
  rsiAlignSeries = rsiChart.addLineSeries({
    color: "transparent",
    lineVisible: false,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
    autoscaleInfoProvider: () => null,
  });

  rsiSeries = rsiChart.addLineSeries({
    color: "#a855f7",
    lineWidth: 2,
    title: "RSI 14",
    priceLineVisible: false,
    lastValueVisible: true,
  });

  // Líneas horizontales fijas de referencia en el RSI: 70 (rojo), 50 (gris), 30 (verde)
  rsiSeries.createPriceLine({
    price: 70,
    color: "#ef4444",
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    axisLabelVisible: true,
    title: "70",
  });
  rsiSeries.createPriceLine({
    price: 50,
    color: "#64748b",
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    axisLabelVisible: true,
    title: "50",
  });
  rsiSeries.createPriceLine({
    price: 30,
    color: "#22c55e",
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    axisLabelVisible: true,
    title: "30",
  });

  // --- C. Sincronización Bidireccional de Scroll y Zoom (Logical Range) ---
  chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    renderOverlayHandles();
    if (isSyncingRange || !range) return;
    isSyncingRange = true;
    rsiChart.timeScale().setVisibleLogicalRange(range);
    isSyncingRange = false;
  });

  rsiChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (isSyncingRange || !range) return;
    isSyncingRange = true;
    chart.timeScale().setVisibleLogicalRange(range);
    renderOverlayHandles();
    isSyncingRange = false;
  });

  chart.timeScale().subscribeVisibleTimeRangeChange(renderOverlayHandles);

  // --- D. Sincronización de Crosshair y Eventos de Click ---
  chart.subscribeClick(handleChartClick);

  chart.subscribeCrosshairMove((param) => {
    handleMainCrosshairMove(param);
    if (isSyncingCrosshair) return;
    isSyncingCrosshair = true;
    syncCrosshairToTarget(param, rsiChart, rsiSeries, "rsi_14");
    isSyncingCrosshair = false;
  });

  rsiChart.subscribeCrosshairMove((param) => {
    if (isSyncingCrosshair) return;
    isSyncingCrosshair = true;
    syncCrosshairToTarget(param, chart, candleSeries, "close");
    if (param.time) {
      const timeKey = resolveTimeFromParam(param);
      const bar = timeKey ? state.historyByTime.get(timeKey) : null;
      if (bar) updateLegendWithBar(bar);
    } else if (state.historyData.length > 0) {
      updateLegendWithBar(state.historyData[state.historyData.length - 1]);
    }
    isSyncingCrosshair = false;
  });

  // --- E. Redimensionamiento Automático ---
  const mainResizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      chart.applyOptions({ width, height });
      renderOverlayHandles();
    }
  });
  mainResizeObserver.observe(elChartContainer);

  const rsiResizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      rsiChart.applyOptions({ width, height });
    }
  });
  rsiResizeObserver.observe(elRsiChartContainer);
}

function syncCrosshairToTarget(param, targetChart, targetSeries, fieldName) {
  if (!targetChart || !targetSeries) return;
  if (!param || !param.time || !param.point) {
    if (typeof targetChart.clearCrosshairPosition === "function") {
      targetChart.clearCrosshairPosition();
    }
    return;
  }
  const timeKey = resolveTimeFromParam(param);
  const bar = timeKey ? state.historyByTime.get(timeKey) : null;
  if (
    bar &&
    bar[fieldName] !== null &&
    bar[fieldName] !== undefined &&
    typeof targetChart.setCrosshairPosition === "function"
  ) {
    try {
      targetChart.setCrosshairPosition(bar[fieldName], timeKey, targetSeries);
    } catch (_) {}
  }
}

// ============================================================================
// 2. CARGA DE DATOS, MULTI-TIMEFRAME Y FULL SYNC DESDE FASTAPI
// ============================================================================

async function fetchTickers() {
  try {
    const res = await fetch(`${API_BASE}/api/tickers`);
    if (!res.ok) throw new Error("No se pudo obtener la lista de tickers");
    const data = await res.json();
    const rawList = Array.isArray(data) ? data : data.tickers || [];
    state.tickers = [...rawList].sort((a, b) => a.localeCompare(b));
    renderTickerList();

    if (state.tickers.length > 0) {
      await selectTicker(state.tickers[0]);
    }
  } catch (err) {
    console.error(err);
    elLegendOhlc.textContent =
      "Error conectando con FastAPI. Verificá que el servidor esté corriendo en el puerto 8000.";
  }
}

function renderTickerList() {
  elTickerList.innerHTML = "";
  const query = (state.tickerSearchQuery || "").trim().toUpperCase();
  const sortedTickers = [...state.tickers].sort((a, b) => a.localeCompare(b));
  const filtered = query
    ? sortedTickers.filter((t) => t.toUpperCase().includes(query))
    : sortedTickers;

  if (filtered.length === 0) {
    const emptyLi = document.createElement("li");
    emptyLi.className = "empty-hint";
    emptyLi.textContent = `Sin coincidencias para "${query}"`;
    elTickerList.appendChild(emptyLi);
    return;
  }

  filtered.forEach((ticker) => {
    const li = document.createElement("li");
    li.className = `ticker-item ${ticker === state.activeTicker ? "active" : ""}`;
    const isLocal = ticker.endsWith(".BA");
    li.innerHTML = `
      <span>${ticker}</span>
      <span class="ticker-market-tag">${isLocal ? "BYMA" : "US"}</span>
    `;
    li.addEventListener("click", () => selectTicker(ticker));
    elTickerList.appendChild(li);
  });
}

// Genera puntos whitespace futuros ({ time: "YYYY-MM-DD" }) para poder dibujar libremente a la derecha de la última vela
function generateFutureWhitespace(lastTimeStr, timeframe, count = 250) {
  if (!lastTimeStr) return [];
  const parts = lastTimeStr.split("-").map(Number);
  if (parts.length !== 3) return [];

  const cur = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  const result = [];

  for (let i = 0; i < count; i++) {
    if (timeframe === "1W") {
      cur.setUTCDate(cur.getUTCDate() + 7);
    } else if (timeframe === "1M") {
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    } else {
      // 1D: avanzar al siguiente día hábil (Lunes a Viernes)
      do {
        cur.setUTCDate(cur.getUTCDate() + 1);
      } while (cur.getUTCDay() === 0 || cur.getUTCDay() === 6);
    }
    const yyyy = cur.getUTCFullYear();
    const mm = String(cur.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(cur.getUTCDate()).padStart(2, "0");
    result.push({ time: `${yyyy}-${mm}-${dd}` });
  }
  return result;
}

async function selectTicker(ticker, forceIncremental = false) {
  const cleanTicker = ticker.trim().toUpperCase();
  if (!cleanTicker) return;

  cancelPendingDrawing();
  deselectDrawing();

  state.activeTicker = cleanTicker;
  if (!state.tickers.includes(cleanTicker)) {
    state.tickers.push(cleanTicker);
    state.tickers.sort((a, b) => a.localeCompare(b));
  }
  renderTickerList();

  const tfLabels = { "1D": "Diario", "1W": "Semanal", "1M": "Mensual" };
  elActiveTickerTitle.textContent = `${cleanTicker} · ${tfLabels[state.timeframe] || state.timeframe}`;
  elNotesTickerLabel.textContent = cleanTicker;
  elCacheBadge.textContent = "Cargando...";
  elCacheBadge.className = "badge";

  clearVisualDrawingsFromChart();

  try {
    const [historyRes, annotRes] = await Promise.all([
      fetch(
        `${API_BASE}/api/history/${encodeURIComponent(cleanTicker)}?timeframe=${state.timeframe}&force=${forceIncremental}`
      ),
      fetch(`${API_BASE}/api/annotations/${encodeURIComponent(cleanTicker)}`),
    ]);

    if (!historyRes.ok) {
      const errBody = await historyRes.json().catch(() => ({}));
      throw new Error(errBody.detail || `Error al cargar ${cleanTicker}`);
    }

    const historyPayload = await historyRes.json();
    const annotationsPayload = annotRes.ok
      ? await annotRes.json()
      : { notes: "", horizontals: [], trendlines: [], fibonaccis: [], measures: [] };

    // Actualizar etiqueta de estado de caché SQLite
    const syncStatus = historyPayload.sync_status;
    if (syncStatus === "cached") {
      elCacheBadge.textContent = "Caché SQLite";
      elCacheBadge.className = "badge cached";
    } else if (syncStatus === "incremental") {
      elCacheBadge.textContent = "Sync Incremental";
      elCacheBadge.className = "badge fresh";
    } else {
      elCacheBadge.textContent = "10Y Descargado";
      elCacheBadge.className = "badge fresh";
    }

    // Poblar diccionario de barras para la leyenda
    const rows = historyPayload.data || [];
    state.historyData = rows;
    state.historyByTime.clear();
    for (const r of rows) {
      state.historyByTime.set(r.time, r);
    }

    // Poblar series de velas e indicadores (pre-filtrados sin NaN ni null en el backend)
    const candles = historyPayload.candles || [];
    const ind = historyPayload.indicators || {};

    candleSeries.setData(candles);
    ema9Series.setData(ind.ema9 || []);
    ema21Series.setData(ind.ema21 || []);
    ema50Series.setData(ind.ema50 || []);
    ema100Series.setData(ind.ema100 || historyPayload.ema100 || []);
    ema200Series.setData(ind.ema200 || []);
    sma200Series.setData(ind.sma200 || historyPayload.sma200 || []);
    wma200Series.setData(ind.wma200 || []);

    // Alinear el eje temporal 1:1 y agregar 250 barras whitespace hacia la derecha para proyectar dibujos al futuro
    const lastCandleTime = candles.length > 0 ? candles[candles.length - 1].time : null;
    const futureWhitespace = generateFutureWhitespace(lastCandleTime, state.timeframe, 250);
    const fullTimelineWhitespace = [
      ...candles.map((c) => ({ time: c.time })),
      ...futureWhitespace,
    ];
    state.timelineDates = fullTimelineWhitespace.map((pt) => pt.time);

    mainAlignSeries.setData(fullTimelineWhitespace);
    rsiAlignSeries.setData(fullTimelineWhitespace);
    rsiSeries.setData(ind.rsi14 || []);

    if (rows.length > 0) {
      updateLegendWithBar(rows[rows.length - 1]);
    }

    // Cargar y renderizar anotaciones del ticker
    state.annotations = {
      notes: annotationsPayload.notes || "",
      horizontals: annotationsPayload.horizontals || [],
      trendlines: annotationsPayload.trendlines || [],
      fibonaccis: annotationsPayload.fibonaccis || [],
      measures: annotationsPayload.measures || [],
    };

    elTickerNotes.value = state.annotations.notes;
    renderAllSavedDrawings();
    renderDrawingsSidebarList();

    // Mostrar las últimas ~180 barras reales + 30 barras libres a la derecha para dibujar cómodo
    const rightMarginBars = 30;
    const visibleHistoryBars = Math.min(candles.length, 180);
    if (candles.length > 0) {
      const logicalRange = {
        from: Math.max(0, candles.length - visibleHistoryBars),
        to: candles.length - 1 + rightMarginBars,
      };
      chart.timeScale().setVisibleLogicalRange(logicalRange);
      rsiChart.timeScale().setVisibleLogicalRange(logicalRange);
    } else {
      chart.timeScale().fitContent();
      rsiChart.timeScale().fitContent();
    }

    setTimeout(renderOverlayHandles, 50);
  } catch (err) {
    console.error(err);
    alert(`No se pudo cargar el ticker ${cleanTicker}: ${err.message}`);
  }
}

async function runFullSync() {
  if (!state.activeTicker) return;
  const ticker = state.activeTicker;

  btnFullSync.disabled = true;
  const origText = btnFullSync.textContent;
  btnFullSync.textContent = "⏳ Sincronizando 10Y...";
  elCacheBadge.textContent = "Full Sync...";
  elCacheBadge.className = "badge fresh";

  try {
    const res = await fetch(
      `${API_BASE}/api/sync/${encodeURIComponent(ticker)}`,
      { method: "POST" }
    );
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.detail || "Error en Full Sync");
    }
    await selectTicker(ticker, false);
  } catch (err) {
    console.error(err);
    alert(`Error al ejecutar Full Sync para ${ticker}: ${err.message}`);
  } finally {
    btnFullSync.disabled = false;
    btnFullSync.textContent = origText;
  }
}

// ============================================================================
// 3. GESTIÓN VISUAL DE LÍNEAS HORIZONTALES, TENDENCIAS Y FIBONACCI
// ============================================================================

function clearVisualDrawingsFromChart() {
  for (const [, priceLine] of priceLineRefs.entries()) {
    try {
      candleSeries.removePriceLine(priceLine);
    } catch (_) {}
  }
  priceLineRefs.clear();
  elHandlesOverlay.innerHTML = "";
}

function renderAllSavedDrawings() {
  clearVisualDrawingsFromChart();

  for (const h of state.annotations.horizontals) {
    mountHorizontalLine(h);
  }

  renderOverlayHandles();
}

function mountHorizontalLine(h) {
  const priceLine = candleSeries.createPriceLine({
    price: h.price,
    color: h.color || "#f59e0b",
    lineWidth: 2,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    axisLabelVisible: true,
    title: h.title || "S/R",
  });
  priceLineRefs.set(h.id, priceLine);
}

// ============================================================================
// 4. INTERACTIVIDAD DE DIBUJO (TENDENCIA, HORIZONTAL Y FIBONACCI)
// ============================================================================

function setDrawingMode(mode) {
  state.drawingMode = mode;
  if (elHandlesOverlay) {
    elHandlesOverlay.classList.toggle("drawing-active", mode !== "cursor");
  }
  cancelPendingDrawing();
  if (mode !== "cursor") {
    deselectDrawing();
  }

  btnModeCursor.classList.toggle("active", mode === "cursor");
  btnModeTrendline.classList.toggle("active", mode === "trendline");
  btnModeHorizontal.classList.toggle("active", mode === "horizontal");
  btnModeFibonacci.classList.toggle("active", mode === "fibonacci");
  btnModeMeasure.classList.toggle("active", mode === "measure");

  if (mode === "trendline") {
    showHint("Modo Línea de Tendencia: Hacé click en el Punto 1 sobre el gráfico.");
  } else if (mode === "horizontal") {
    showHint("Modo Línea Horizontal: Hacé click en el nivel de precio para marcar Soporte/Resistencia.");
  } else if (mode === "fibonacci") {
    showHint(
      "Modo Fibonacci: 1er click en el inicio del impulso (P1) y 2do click en el fin del impulso (P2)."
    );
  } else if (mode === "measure") {
    showHint(
      "Modo Medición / Regla: 1er click en el precio inicial y 2do click en el precio final para medir subida o bajada (% y USD)."
    );
  } else {
    hideHint();
  }
}

function showHint(text) {
  elDrawingHint.textContent = text;
  elDrawingHint.classList.remove("hidden");
}

function hideHint() {
  elDrawingHint.textContent = "";
  elDrawingHint.classList.add("hidden");
}

function cancelPendingDrawing() {
  state.pendingPoint = null;
  state.previewMouseEnd = null;
  renderOverlayHandles();
}

function formatTimeValue(t) {
  if (!t) return null;
  if (typeof t === "string") return t;
  if (t.year) {
    const m = String(t.month).padStart(2, "0");
    const d = String(t.day).padStart(2, "0");
    return `${t.year}-${m}-${d}`;
  }
  return null;
}

function logicalIndexToTime(logicalIdx) {
  const dates = state.timelineDates || [];
  if (dates.length === 0) return null;
  const idx = Math.round(logicalIdx);
  if (idx <= 0) return dates[0];
  if (idx < dates.length) return dates[idx];

  const extraBars = idx - (dates.length - 1);
  const extra = generateFutureWhitespace(dates[dates.length - 1], state.timeframe, extraBars);
  return extra.length > 0 ? extra[extra.length - 1].time : dates[dates.length - 1];
}

function timeToLogicalIndex(timeStr) {
  const dates = state.timelineDates || [];
  if (!timeStr || dates.length === 0) return null;

  const lastDateStr = dates[dates.length - 1];
  if (timeStr > lastDateStr) {
    const tLast = Date.parse(lastDateStr);
    const tTarget = Date.parse(timeStr);
    if (!isNaN(tLast) && !isNaN(tTarget)) {
      const diffDays = (tTarget - tLast) / (1000 * 60 * 60 * 24);
      const stepDays = state.timeframe === "1M" ? 30.4 : state.timeframe === "1W" ? 7 : 1.4;
      return dates.length - 1 + Math.round(diffDays / stepDays);
    }
  }

  let lo = 0;
  let hi = dates.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (dates[mid] < timeStr) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function resolveTimeFromX(x) {
  if (x === null || x === undefined || !chart) return null;
  const direct = formatTimeValue(chart.timeScale().coordinateToTime(x));
  if (direct) return direct;

  const logical = chart.timeScale().coordinateToLogical(x);
  if (logical === null || logical === undefined) return null;
  return logicalIndexToTime(logical);
}

function timeToXCoordinate(timeStr) {
  if (!timeStr || !chart) return null;
  const direct = chart.timeScale().timeToCoordinate(timeStr);
  if (direct !== null && direct !== undefined) return direct;

  const logicalIdx = timeToLogicalIndex(timeStr);
  if (logicalIdx === null) return null;
  return chart.timeScale().logicalToCoordinate(logicalIdx);
}

function resolveTimeFromParam(param) {
  const fromTime = formatTimeValue(param.time);
  if (fromTime) return fromTime;
  if (param.point) {
    return resolveTimeFromX(param.point.x);
  }
  return null;
}

function snapPriceToHorizontal(yCoord, rawPrice) {
  if (
    !candleSeries ||
    !state.annotations ||
    !Array.isArray(state.annotations.horizontals)
  ) {
    return rawPrice;
  }
  const SNAP_THRESHOLD_PX = 6;
  let closestPrice = rawPrice;
  let minDiff = SNAP_THRESHOLD_PX + 1;

  for (const h of state.annotations.horizontals) {
    const hy = candleSeries.priceToCoordinate(h.price);
    if (hy !== null && hy !== undefined) {
      const diff = Math.abs(yCoord - hy);
      if (diff <= SNAP_THRESHOLD_PX && diff < minDiff) {
        minDiff = diff;
        closestPrice = h.price;
      }
    }
  }
  return closestPrice;
}

function handleChartClick(param) {
  if (!param.point || !state.activeTicker || state.dragging) return;

  const rawClickedPrice = candleSeries.coordinateToPrice(param.point.y);
  if (rawClickedPrice === null || rawClickedPrice === undefined) return;

  if (state.drawingMode === "cursor") {
    deselectDrawing();
    return;
  }

  const clickedPrice =
    state.drawingMode === "horizontal"
      ? rawClickedPrice
      : snapPriceToHorizontal(param.point.y, rawClickedPrice);

  // --- A. MODO LÍNEA HORIZONTAL ---
  if (state.drawingMode === "horizontal") {
    const newHoriz = {
      id: `h_${Date.now()}`,
      price: Number(clickedPrice.toFixed(2)),
      color: "#f59e0b",
      title: "S/R",
    };
    state.annotations.horizontals.push(newHoriz);
    mountHorizontalLine(newHoriz);
    selectDrawing("horizontal", newHoriz.id);
    saveAnnotations();
    return;
  }

  // --- B. MODO LÍNEA DE TENDENCIA ---
  if (state.drawingMode === "trendline") {
    const clickedTime = resolveTimeFromParam(param);
    if (!clickedTime) return;

    if (!state.pendingPoint) {
      deselectDrawing();
      state.pendingPoint = {
        time: clickedTime,
        price: Number(clickedPrice.toFixed(2)),
      };
      state.previewMouseEnd = { ...state.pendingPoint };
      renderOverlayHandles();
      showHint(
        `Punto 1 fijado (${clickedTime} @ $${clickedPrice.toFixed(2)}). Hacé click en el Punto 2 (Esc para cancelar).`
      );
    } else {
      const p1 = state.pendingPoint;
      const p2 = {
        time: clickedTime,
        price: Number(clickedPrice.toFixed(2)),
      };

      if (p1.time === p2.time) {
        showHint("Elegí una vela con fecha distinta al Punto 1 para trazar la tendencia.");
        return;
      }

      const newTrend = {
        id: `t_${Date.now()}`,
        time1: p1.time,
        price1: p1.price,
        time2: p2.time,
        price2: p2.price,
        color: "#22c55e",
      };

      state.annotations.trendlines.push(newTrend);
      cancelPendingDrawing();
      selectDrawing("trendline", newTrend.id);
      saveAnnotations();
      showHint("Línea de tendencia guardada.");
    }
    return;
  }

  // --- C. MODO RETROCESO DE FIBONACCI ---
  if (state.drawingMode === "fibonacci") {
    const clickedTime = resolveTimeFromParam(param);
    if (!clickedTime) return;

    if (!state.pendingPoint) {
      deselectDrawing();
      state.pendingPoint = {
        time: clickedTime,
        price: Number(clickedPrice.toFixed(2)),
      };
      state.previewMouseEnd = { ...state.pendingPoint };
      renderOverlayHandles();
      showHint(
        `Inicio del impulso P1 fijado ($${clickedPrice.toFixed(2)}). Hacé click en el fin del impulso P2 (Esc para cancelar).`
      );
    } else {
      const p1 = state.pendingPoint;
      const p2 = {
        time: clickedTime,
        price: Number(clickedPrice.toFixed(2)),
      };

      if (Math.abs(p2.price - p1.price) < 0.0001) {
        showHint("Elegí un Precio B distinto al Precio A para calcular los niveles de Fibonacci.");
        return;
      }

      const newFib = {
        id: `f_${Date.now()}`,
        time1: p1.time,
        price1: p1.price,
        time2: p2.time,
        price2: p2.price,
        color: "#eab308",
      };

      state.annotations.fibonaccis.push(newFib);
      cancelPendingDrawing();
      selectDrawing("fibonacci", newFib.id);
      saveAnnotations();
      showHint("Retroceso de Fibonacci guardado en SQLite.");
    }
    return;
  }

  // --- D. MODO MEDICIÓN (REGLA / PORCENTAJE DE SUBIDA O BAJADA) ---
  if (state.drawingMode === "measure") {
    const clickedTime = resolveTimeFromParam(param);
    if (!clickedTime) return;

    if (!state.pendingPoint) {
      deselectDrawing();
      state.pendingPoint = {
        time: clickedTime,
        price: Number(clickedPrice.toFixed(2)),
      };
      state.previewMouseEnd = { ...state.pendingPoint };
      renderOverlayHandles();
      showHint(
        `Origen de medición fijado en $${clickedPrice.toFixed(2)} (${clickedTime}). Hacé click en el destino para medir (Esc para cancelar).`
      );
    } else {
      const p1 = state.pendingPoint;
      const p2 = {
        time: clickedTime,
        price: Number(clickedPrice.toFixed(2)),
      };

      const isUp = p2.price >= p1.price;
      const newMeasure = {
        id: `m_${Date.now()}`,
        time1: p1.time,
        price1: p1.price,
        time2: p2.time,
        price2: p2.price,
        color: isUp ? "#22c55e" : "#ef4444",
      };

      state.annotations.measures.push(newMeasure);
      cancelPendingDrawing();
      selectDrawing("measure", newMeasure.id);
      saveAnnotations();
      showHint("Medición fijada. Podés arrastrar sus extremos o borrarla cuando quieras.");
    }
  }
}

function handleMainCrosshairMove(param) {
  if (
    (state.drawingMode === "trendline" ||
      state.drawingMode === "fibonacci" ||
      state.drawingMode === "measure") &&
    state.pendingPoint &&
    param.point
  ) {
    const currentTime = resolveTimeFromParam(param) || state.pendingPoint.time;
    const rawCurrentPrice = candleSeries.coordinateToPrice(param.point.y);
    if (rawCurrentPrice !== null && rawCurrentPrice !== undefined) {
      const currentPrice = snapPriceToHorizontal(param.point.y, rawCurrentPrice);
      state.previewMouseEnd = {
        time: currentTime,
        price: Number(currentPrice.toFixed(2)),
      };
      renderOverlayHandles();
    }
  }

  if (!param.time) {
    if (state.historyData.length > 0) {
      updateLegendWithBar(state.historyData[state.historyData.length - 1]);
    }
    return;
  }

  const timeKey = resolveTimeFromParam(param);
  const bar = timeKey ? state.historyByTime.get(timeKey) : null;
  if (bar) {
    updateLegendWithBar(bar);
  }
}

function updateLegendWithBar(bar) {
  const fmt = (v) => (v !== null && v !== undefined ? Number(v).toFixed(2) : "—");
  elLegendOhlc.innerHTML = `
    <span class="legend-item"><span class="legend-label">${bar.time}</span></span>
    <span class="legend-item"><span class="legend-label">O:</span> ${fmt(bar.open)}</span>
    <span class="legend-item"><span class="legend-label">H:</span> ${fmt(bar.high)}</span>
    <span class="legend-item"><span class="legend-label">L:</span> ${fmt(bar.low)}</span>
    <span class="legend-item"><span class="legend-label">C:</span> <strong>${fmt(bar.close)}</strong></span>
    <span class="legend-item" style="color:#38bdf8"><span class="legend-label">EMA9:</span> ${fmt(bar.ema_9)}</span>
    <span class="legend-item" style="color:#22c55e"><span class="legend-label">EMA21:</span> ${fmt(bar.ema_21)}</span>
    <span class="legend-item" style="color:#60a5fa"><span class="legend-label">EMA50:</span> ${fmt(bar.ema_50)}</span>
    <span class="legend-item" style="color:#00E5FF"><span class="legend-label">EMA100:</span> ${fmt(bar.ema_100)}</span>
    <span class="legend-item" style="color:#f87171"><span class="legend-label">EMA200:</span> ${fmt(bar.ema_200)}</span>
    <span class="legend-item" style="color:#E0E0E0"><span class="legend-label">SMA200:</span> ${fmt(bar.sma_200)}</span>
    <span class="legend-item" style="color:#fbbf24"><span class="legend-label">WMA200:</span> ${fmt(bar.wma_200)}</span>
  `;
  elLegendRsiValue.textContent = fmt(bar.rsi_14);
}

// ============================================================================
// 5. SELECCIÓN, EDICIÓN INDIVIDUAL Y RENDERIZADO SVG (TENDENCIA + FIBONACCI)
// ============================================================================

function selectDrawing(type, id) {
  state.selectedDrawing = { type, id };
  updateSelectedDrawingToolbar();
  renderOverlayHandles();
  renderDrawingsSidebarList();
}

function deselectDrawing() {
  if (!state.selectedDrawing) return;
  state.selectedDrawing = null;
  elSelectedBar.classList.add("hidden");
  renderOverlayHandles();
  renderDrawingsSidebarList();
}

function getSelectedItem() {
  if (!state.selectedDrawing) return null;
  const { type, id } = state.selectedDrawing;
  if (type === "horizontal") {
    return state.annotations.horizontals.find((h) => h.id === id) || null;
  }
  if (type === "fibonacci") {
    return state.annotations.fibonaccis.find((f) => f.id === id) || null;
  }
  if (type === "measure") {
    return state.annotations.measures.find((m) => m.id === id) || null;
  }
  return state.annotations.trendlines.find((t) => t.id === id) || null;
}

function updateSelectedDrawingToolbar() {
  const item = getSelectedItem();
  if (!item || !state.selectedDrawing) {
    elSelectedBar.classList.add("hidden");
    return;
  }

  const { type } = state.selectedDrawing;
  elSelectedBar.classList.remove("hidden");

  const defaultColor =
    type === "horizontal"
      ? "#f59e0b"
      : type === "fibonacci"
      ? "#eab308"
      : type === "measure"
      ? (item.price2 >= item.price1 ? "#22c55e" : "#ef4444")
      : "#22c55e";
  const currentColor = (item.color || defaultColor).toLowerCase();

  elColorPicker.querySelectorAll(".color-dot").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.color.toLowerCase() === currentColor);
  });

  if (type === "horizontal") {
    elSelectedType.textContent = "― Línea Horizontal";
    elEditHorizFields.classList.remove("hidden");
    elEditTrendFields.classList.add("hidden");
    elEditHorizPrice.value = Number(item.price).toFixed(2);
    elEditHorizTitle.value = item.title || "S/R";
  } else {
    elSelectedType.textContent =
      type === "fibonacci"
        ? "📐 Fibonacci"
        : type === "measure"
        ? "📏 Medición"
        : "╱ Línea de Tendencia";
    elEditTrendFields.classList.remove("hidden");
    elEditHorizFields.classList.add("hidden");
    elEditTrendP1.value = Number(item.price1).toFixed(2);
    elEditTrendP2.value = Number(item.price2).toFixed(2);
  }
}

function createSvgLine(x1, y1, x2, y2, color, dashed = false, strokeWidth = 2) {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", x1);
  line.setAttribute("y1", y1);
  line.setAttribute("x2", x2);
  line.setAttribute("y2", y2);
  line.setAttribute("stroke", color);
  line.setAttribute("stroke-width", String(strokeWidth));
  if (dashed) {
    line.setAttribute("stroke-dasharray", "5 4");
  }
  elHandlesOverlay.appendChild(line);
}

function createSvgText(x, y, textContent, fill, isGolden = false) {
  const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
  txt.setAttribute("x", x);
  txt.setAttribute("y", y);
  txt.setAttribute("fill", fill);
  txt.setAttribute("class", isGolden ? "fib-label fib-golden" : "fib-label");
  txt.textContent = textContent;
  elHandlesOverlay.appendChild(txt);
}

function createSvgHitLine(x1, y1, x2, y2, meta) {
  const hitLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
  hitLine.setAttribute("x1", x1);
  hitLine.setAttribute("y1", y1);
  hitLine.setAttribute("x2", x2);
  hitLine.setAttribute("y2", y2);
  hitLine.setAttribute(
    "class",
    meta.type === "horizontal" ? "svg-hit-line horizontal-hit" : "svg-hit-line"
  );

  hitLine.addEventListener("mousedown", (e) => {
    if (state.drawingMode !== "cursor" && state.pendingPoint) return;
    e.stopPropagation();
    e.preventDefault();

    selectDrawing(meta.type, meta.id);

    const rect = elChartContainer.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const startMousePrice = candleSeries.coordinateToPrice(clickY);
    const startMouseLogical = chart.timeScale().coordinateToLogical(clickX);

    if (meta.type === "horizontal") {
      startDraggingHandle({ type: "horizontal", id: meta.id });
    } else if (
      (meta.type === "trendline" || meta.type === "fibonacci") &&
      startMousePrice !== null
    ) {
      const list =
        meta.type === "fibonacci"
          ? state.annotations.fibonaccis
          : state.annotations.trendlines;
      const item = list.find((d) => d.id === meta.id);
      if (item) {
        startDraggingHandle({
          type: `${meta.type}-body`,
          id: meta.id,
          startMouseY: clickY,
          startMousePrice,
          startMouseLogical,
          origP1: item.price1,
          origP2: item.price2,
          origLogical1: timeToLogicalIndex(item.time1),
          origLogical2: timeToLogicalIndex(item.time2),
        });
      }
    }
  });

  hitLine.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    selectDrawing(meta.type, meta.id);
  });

  elHandlesOverlay.appendChild(hitLine);
}

function renderMeasureInSvg(m, paneWidth, isPreview = false, isSelected = false) {
  const x1Raw = timeToXCoordinate(m.time1);
  const x2Raw = timeToXCoordinate(m.time2);
  const y1 = candleSeries.priceToCoordinate(m.price1);
  const y2 = candleSeries.priceToCoordinate(m.price2);

  if (y1 === null || y2 === null) return;

  const p1 = Number(m.price1);
  const p2 = Number(m.price2);
  const deltaPrice = p2 - p1;
  const pctChange = p1 !== 0 ? (deltaPrice / p1) * 100 : 0;
  const isUp = deltaPrice >= 0;

  // Si x1 o x2 no están visibles, asignamos un ancho mínimo de visualización
  const x1 = x1Raw !== null ? x1Raw : 40;
  const x2 = x2Raw !== null ? x2Raw : x1 + 80;

  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.max(16, Math.abs(x2 - x1));
  const height = Math.max(12, Math.abs(y2 - y1));

  // 1. Rectángulo de Medición (Caja coloreada verde/roja)
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", String(left));
  rect.setAttribute("y", String(top));
  rect.setAttribute("width", String(width));
  rect.setAttribute("height", String(height));
  rect.setAttribute("class", isUp ? "measure-box up" : "measure-box down");
  if (isSelected) {
    rect.style.strokeWidth = "2.2px";
    rect.style.strokeDasharray = "none";
  }
  elHandlesOverlay.appendChild(rect);

  // 2. Línea guía vertical interna del movimiento
  const midX = left + width / 2;
  const guideLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
  guideLine.setAttribute("x1", String(midX));
  guideLine.setAttribute("y1", String(y1));
  guideLine.setAttribute("x2", String(midX));
  guideLine.setAttribute("y2", String(y2));
  guideLine.setAttribute("class", isUp ? "measure-arrow up" : "measure-arrow down");
  elHandlesOverlay.appendChild(guideLine);

  // 3. Etiqueta / Pill con datos calculados: +/- % y USD
  const sign = isUp ? "+" : "";
  const labelText = `${sign}${pctChange.toFixed(2)}% (${sign}$${deltaPrice.toFixed(2)})`;

  const txtY = top > 24 ? top - 6 : top + height + 16;
  const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
  txt.setAttribute("x", String(midX));
  txt.setAttribute("y", String(txtY));
  txt.setAttribute("class", isUp ? "measure-label-pill up" : "measure-label-pill down");
  txt.textContent = labelText;
  elHandlesOverlay.appendChild(txt);

  // 4. Área clickeable para seleccionar / arrastrar la medición completa
  if (!isPreview && m.id) {
    const hitArea = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    hitArea.setAttribute("x", String(left));
    hitArea.setAttribute("y", String(top));
    hitArea.setAttribute("width", String(width));
    hitArea.setAttribute("height", String(height));
    hitArea.setAttribute("fill", "transparent");
    hitArea.style.pointerEvents = "all";
    hitArea.style.cursor = "move";

    hitArea.addEventListener("mousedown", (e) => {
      if (state.drawingMode !== "cursor" && state.pendingPoint) return;
      e.stopPropagation();
      e.preventDefault();
      selectDrawing("measure", m.id);

      const chartRect = elChartContainer.getBoundingClientRect();
      const clickX = e.clientX - chartRect.left;
      const clickY = e.clientY - chartRect.top;
      const startMousePrice = candleSeries.coordinateToPrice(clickY);
      const startMouseLogical = chart.timeScale().coordinateToLogical(clickX);
      if (startMousePrice !== null) {
        startDraggingHandle({
          type: "measure-body",
          id: m.id,
          startMouseY: clickY,
          startMousePrice,
          startMouseLogical,
          origP1: m.price1,
          origP2: m.price2,
          origLogical1: timeToLogicalIndex(m.time1),
          origLogical2: timeToLogicalIndex(m.time2),
        });
      }
    });

    hitArea.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectDrawing("measure", m.id);
    });

    elHandlesOverlay.appendChild(hitArea);

    // Manejadores en las dos esquinas P1 y P2
    if (x1Raw !== null && y1 !== null) {
      createSvgHandle(
        x1Raw,
        y1,
        isUp ? "#22c55e" : "#ef4444",
        { type: "measure", id: m.id, endpoint: 1 },
        isSelected
      );
    }
    if (x2Raw !== null && y2 !== null) {
      createSvgHandle(
        x2Raw,
        y2,
        isUp ? "#22c55e" : "#ef4444",
        { type: "measure", id: m.id, endpoint: 2 },
        isSelected
      );
    }
  }
}

function renderFibonacciInSvg(fib, paneWidth, isPreview = false, isSelected = false) {
  const x1Raw = timeToXCoordinate(fib.time1);
  const x2Raw = timeToXCoordinate(fib.time2);
  const y1 = candleSeries.priceToCoordinate(fib.price1);
  const y2 = candleSeries.priceToCoordinate(fib.price2);

  const leftX =
    x1Raw !== null && x2Raw !== null
      ? Math.max(0, Math.min(x1Raw, x2Raw))
      : 40;
  const rightX = paneWidth > 0 ? paneWidth - 6 : elChartContainer.clientWidth - 78;

  const p1 = Number(fib.price1);
  const p2 = Number(fib.price2);
  const baseColor = fib.color || "#eab308";

  // Sombreado sutil para la "Golden Zone" entre 0.50 y 0.618
  const price50 = p2 - (p2 - p1) * 0.5;
  const price618 = p2 - (p2 - p1) * 0.618;
  const y50 = candleSeries.priceToCoordinate(price50);
  const y618 = candleSeries.priceToCoordinate(price618);

  if (y50 !== null && y618 !== null && rightX > leftX) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(leftX));
    rect.setAttribute("y", String(Math.min(y50, y618)));
    rect.setAttribute("width", String(rightX - leftX));
    rect.setAttribute("height", String(Math.max(1, Math.abs(y618 - y50))));
    rect.setAttribute("fill", "rgba(234, 179, 8, 0.11)");
    rect.setAttribute("pointer-events", "none");
    elHandlesOverlay.appendChild(rect);
  }

  // Línea diagonal punteada del impulso (P1 -> P2)
  if (x1Raw !== null && y1 !== null && x2Raw !== null && y2 !== null) {
    createSvgLine(x1Raw, y1, x2Raw, y2, "#94a3b8", true, 1.4);
  }

  // Dibujar los 7 niveles: Nivel = P2 - (P2 - P1) * r
  for (const r of FIB_RATIOS) {
    const levelPrice = p2 - (p2 - p1) * r;
    const y = candleSeries.priceToCoordinate(levelPrice);
    if (y === null) continue;

    const isGolden = r === 0.5 || r === 0.618;
    const levelColor =
      r === 0.618
        ? "#facc15"
        : r === 0.5
        ? "#38bdf8"
        : r === 0.0 || r === 1.0
        ? "#cbd5e1"
        : baseColor;

    const strokeW = isGolden ? (isSelected ? 2.8 : 2.2) : isSelected ? 2.0 : 1.3;
    createSvgLine(leftX, y, rightX, y, levelColor, !isGolden && r !== 0 && r !== 1, strokeW);

    const pctText = `${(r * 100).toFixed(1)}% ($${levelPrice.toFixed(2)})`;
    createSvgText(leftX + 6, y - 4, pctText, levelColor, isGolden);

    if (!isPreview && fib.id) {
      createSvgHitLine(leftX, y, rightX, y, { type: "fibonacci", id: fib.id });
    }
  }

  // Manejadores arrastrables para P1 y P2
  if (!isPreview && fib.id) {
    if (x1Raw !== null && y1 !== null) {
      createSvgHandle(
        x1Raw,
        y1,
        baseColor,
        { type: "fibonacci", id: fib.id, endpoint: 1 },
        isSelected
      );
    }
    if (x2Raw !== null && y2 !== null) {
      createSvgHandle(
        x2Raw,
        y2,
        baseColor,
        { type: "fibonacci", id: fib.id, endpoint: 2 },
        isSelected
      );
    }
  }
}

function renderOverlayHandles() {
  if (!chart || !candleSeries) return;
  elHandlesOverlay.innerHTML = "";
  elHandlesOverlay.classList.toggle("drawing-active", state.drawingMode !== "cursor");

  const paneWidth = chart.timeScale().width();
  const paneHeight = elChartContainer.clientHeight - chart.timeScale().height();
  if (paneWidth > 0 && paneHeight > 0) {
    elHandlesOverlay.style.width = `${paneWidth}px`;
    elHandlesOverlay.style.height = `${paneHeight}px`;
  }

  // 1. Previsualización en vivo (Tendencia o Fibonacci) mientras se elige el Punto 2
  if (state.pendingPoint && state.previewMouseEnd) {
    if (state.drawingMode === "trendline") {
      const px1 = timeToXCoordinate(state.pendingPoint.time);
      const py1 = candleSeries.priceToCoordinate(state.pendingPoint.price);
      const px2 = timeToXCoordinate(state.previewMouseEnd.time);
      const py2 = candleSeries.priceToCoordinate(state.previewMouseEnd.price);

      if (px1 !== null && py1 !== null && px2 !== null && py2 !== null) {
        createSvgLine(px1, py1, px2, py2, "#22c55e", true, 2);
      }
      if (px1 !== null && py1 !== null) {
        const startDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        startDot.setAttribute("cx", px1);
        startDot.setAttribute("cy", py1);
        startDot.setAttribute("r", "4.5");
        startDot.setAttribute("fill", "#22c55e");
        elHandlesOverlay.appendChild(startDot);
      }
    } else if (state.drawingMode === "fibonacci") {
      renderFibonacciInSvg(
        {
          time1: state.pendingPoint.time,
          price1: state.pendingPoint.price,
          time2: state.previewMouseEnd.time,
          price2: state.previewMouseEnd.price,
          color: "#eab308",
        },
        paneWidth,
        true,
        false
      );
    } else if (state.drawingMode === "measure") {
      renderMeasureInSvg(
        {
          time1: state.pendingPoint.time,
          price1: state.pendingPoint.price,
          time2: state.previewMouseEnd.time,
          price2: state.previewMouseEnd.price,
        },
        paneWidth,
        true,
        false
      );
    }
  }

  // 2. Cajas / Mediciones de Variación guardadas
  for (const m of state.annotations.measures) {
    const isSelected =
      state.selectedDrawing &&
      state.selectedDrawing.type === "measure" &&
      state.selectedDrawing.id === m.id;
    renderMeasureInSvg(m, paneWidth, false, isSelected);
  }

  // 3. Retrocesos de Fibonacci guardados
  for (const f of state.annotations.fibonaccis) {
    const isSelected =
      state.selectedDrawing &&
      state.selectedDrawing.type === "fibonacci" &&
      state.selectedDrawing.id === f.id;
    renderFibonacciInSvg(f, paneWidth, false, isSelected);
  }

  // 4. Líneas de tendencia guardadas
  for (const t of state.annotations.trendlines) {
    const x1 = timeToXCoordinate(t.time1);
    const y1 = candleSeries.priceToCoordinate(t.price1);
    const x2 = timeToXCoordinate(t.time2);
    const y2 = candleSeries.priceToCoordinate(t.price2);
    const isSelected =
      state.selectedDrawing &&
      state.selectedDrawing.type === "trendline" &&
      state.selectedDrawing.id === t.id;

    if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
      createSvgLine(
        x1,
        y1,
        x2,
        y2,
        t.color || "#22c55e",
        false,
        isSelected ? 3.2 : 2
      );
      createSvgHitLine(x1, y1, x2, y2, { type: "trendline", id: t.id });
    }

    if (x1 !== null && y1 !== null) {
      createSvgHandle(
        x1,
        y1,
        t.color || "#22c55e",
        { type: "trendline", id: t.id, endpoint: 1 },
        isSelected
      );
    }
    if (x2 !== null && y2 !== null) {
      createSvgHandle(
        x2,
        y2,
        t.color || "#22c55e",
        { type: "trendline", id: t.id, endpoint: 2 },
        isSelected
      );
    }
  }

  // 4. Líneas horizontales
  for (const h of state.annotations.horizontals) {
    const y = candleSeries.priceToCoordinate(h.price);
    const isSelected =
      state.selectedDrawing &&
      state.selectedDrawing.type === "horizontal" &&
      state.selectedDrawing.id === h.id;

    if (y !== null) {
      createSvgHitLine(0, y, paneWidth || elChartContainer.clientWidth, y, {
        type: "horizontal",
        id: h.id,
      });
      createSvgHandle(
        24,
        y,
        h.color || "#f59e0b",
        { type: "horizontal", id: h.id },
        isSelected
      );
    }
  }
}

function createSvgHandle(cx, cy, strokeColor, meta, isSelected = false) {
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", cx);
  circle.setAttribute("cy", cy);
  const baseRadius = meta.type === "horizontal" ? 5.5 : 5;
  circle.setAttribute("r", String(isSelected ? baseRadius + 1.8 : baseRadius));
  circle.setAttribute(
    "class",
    meta.type === "horizontal" ? "handle-point handle-horizontal" : "handle-point"
  );
  circle.setAttribute("stroke", isSelected ? "#ffffff" : strokeColor);
  if (isSelected) {
    circle.setAttribute("fill", strokeColor);
  }

  circle.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    selectDrawing(meta.type, meta.id);
    startDraggingHandle(meta);
  });

  elHandlesOverlay.appendChild(circle);
}

function startDraggingHandle(meta) {
  state.dragging = meta;
  chart.applyOptions({ handleScroll: false, handleScale: false });
}

window.addEventListener("mousemove", (e) => {
  if (!state.dragging || !chart || !candleSeries) return;

  const rect = elChartContainer.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const newPrice = candleSeries.coordinateToPrice(y);
  if (newPrice === null || newPrice === undefined) return;

  if (state.dragging.type === "horizontal") {
    const item = state.annotations.horizontals.find((h) => h.id === state.dragging.id);
    const priceLine = priceLineRefs.get(state.dragging.id);
    if (item && priceLine) {
      item.price = Number(newPrice.toFixed(2));
      priceLine.applyOptions({ price: item.price });
      updateSelectedDrawingToolbar();
      renderOverlayHandles();
    }
  } else if (
    state.dragging.type === "trendline" ||
    state.dragging.type === "fibonacci" ||
    state.dragging.type === "measure"
  ) {
    const list =
      state.dragging.type === "fibonacci"
        ? state.annotations.fibonaccis
        : state.dragging.type === "measure"
        ? state.annotations.measures
        : state.annotations.trendlines;
    const item = list.find((d) => d.id === state.dragging.id);
    const newTime = resolveTimeFromX(x);
    const snappedPrice = snapPriceToHorizontal(y, newPrice);

    if (item) {
      if (state.dragging.endpoint === 1) {
        if (typeof newTime === "string" && (state.dragging.type === "measure" || newTime !== item.time2)) {
          item.time1 = newTime;
        }
        item.price1 = Number(snappedPrice.toFixed(2));
      } else if (state.dragging.endpoint === 2) {
        if (typeof newTime === "string" && (state.dragging.type === "measure" || newTime !== item.time1)) {
          item.time2 = newTime;
        }
        item.price2 = Number(snappedPrice.toFixed(2));
      }
      updateSelectedDrawingToolbar();
      renderOverlayHandles();
    }
  } else if (
    state.dragging.type === "trendline-body" ||
    state.dragging.type === "fibonacci-body" ||
    state.dragging.type === "measure-body"
  ) {
    const list =
      state.dragging.type === "fibonacci-body"
        ? state.annotations.fibonaccis
        : state.dragging.type === "measure-body"
        ? state.annotations.measures
        : state.annotations.trendlines;
    const item = list.find((d) => d.id === state.dragging.id);
    if (item) {
      // 1. Movimiento Horizontal (desplazar time1 y time2 conservando el ancho en barras)
      const currentLogical = chart.timeScale().coordinateToLogical(x);
      if (
        currentLogical !== null &&
        currentLogical !== undefined &&
        state.dragging.startMouseLogical !== null &&
        state.dragging.startMouseLogical !== undefined &&
        state.dragging.origLogical1 !== null &&
        state.dragging.origLogical2 !== null
      ) {
        const deltaLogical = Math.round(currentLogical - state.dragging.startMouseLogical);
        const newT1 = logicalIndexToTime(state.dragging.origLogical1 + deltaLogical);
        const newT2 = logicalIndexToTime(state.dragging.origLogical2 + deltaLogical);
        if (newT1 && newT2) {
          item.time1 = newT1;
          item.time2 = newT2;
        }
      }

      // 2. Movimiento Vertical:
      // En las cajas de medición ("measure-body"), aplicamos una zona muerta vertical de 10px
      // para que puedas correr la caja hacia los costados sin que se desajuste el precio medido.
      const dyPx =
        state.dragging.startMouseY !== undefined
          ? Math.abs(y - state.dragging.startMouseY)
          : 999;

      if (state.dragging.type === "measure-body" && dyPx <= 10) {
        item.price1 = state.dragging.origP1;
        item.price2 = state.dragging.origP2;
      } else {
        const deltaPrice = newPrice - state.dragging.startMousePrice;
        item.price1 = Number((state.dragging.origP1 + deltaPrice).toFixed(2));
        item.price2 = Number((state.dragging.origP2 + deltaPrice).toFixed(2));
      }

      updateSelectedDrawingToolbar();
      renderOverlayHandles();
    }
  }
});

window.addEventListener("mouseup", () => {
  if (!state.dragging) return;
  state.dragging = null;
  chart.applyOptions({
    handleScroll: true,
    handleScale: COMMON_HANDLE_SCALE,
  });
  renderDrawingsSidebarList();
  saveAnnotations();
});

// ============================================================================
// 6. LISTA LATERAL DE DIBUJOS Y PERSISTENCIA EN SQLITE
// ============================================================================

function renderDrawingsSidebarList() {
  const { horizontals, trendlines, fibonaccis, measures } = state.annotations;
  const safeMeasures = measures || [];
  const total = horizontals.length + trendlines.length + fibonaccis.length + safeMeasures.length;
  elDrawingsCount.textContent = String(total);
  elDrawingsList.innerHTML = "";

  if (total === 0) {
    elDrawingsList.innerHTML =
      '<li class="empty-hint">Sin dibujos activos en este ticker</li>';
    return;
  }

  for (const m of safeMeasures) {
    const isSelected =
      state.selectedDrawing &&
      state.selectedDrawing.type === "measure" &&
      state.selectedDrawing.id === m.id;

    const diff = m.price2 - m.price1;
    const pct = m.price1 !== 0 ? (diff / m.price1) * 100 : 0;
    const sign = diff >= 0 ? "+" : "";

    const li = document.createElement("li");
    li.className = `drawing-item measure ${isSelected ? "selected" : ""}`;
    li.style.borderLeftColor = diff >= 0 ? "#26a69a" : "#ef5350";
    li.innerHTML = `
      <span>📏 ${sign}${pct.toFixed(2)}% (${sign}$${diff.toFixed(2)})</span>
      <div class="drawing-item-actions">
        <button class="drawing-edit-btn" title="Ver / Editar">✎</button>
        <button class="drawing-delete-btn" title="Eliminar Medición">🗑</button>
      </div>
    `;
    li.addEventListener("click", () => selectDrawing("measure", m.id));
    li.querySelector(".drawing-edit-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      selectDrawing("measure", m.id);
    });
    li.querySelector(".drawing-delete-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteDrawing("measure", m.id);
    });
    elDrawingsList.appendChild(li);
  }

  for (const h of horizontals) {
    const isSelected =
      state.selectedDrawing &&
      state.selectedDrawing.type === "horizontal" &&
      state.selectedDrawing.id === h.id;

    const li = document.createElement("li");
    li.className = `drawing-item horizontal ${isSelected ? "selected" : ""}`;
    li.style.borderLeftColor = h.color || "#f59e0b";
    li.innerHTML = `
      <span>― ${h.title || "S/R"}: <strong>$${Number(h.price).toFixed(2)}</strong></span>
      <div class="drawing-item-actions">
        <button class="drawing-edit-btn" title="Editar línea">✎</button>
        <button class="drawing-delete-btn" title="Eliminar línea">🗑</button>
      </div>
    `;
    li.addEventListener("click", () => selectDrawing("horizontal", h.id));
    li.querySelector(".drawing-edit-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      selectDrawing("horizontal", h.id);
    });
    li.querySelector(".drawing-delete-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteDrawing("horizontal", h.id);
    });
    elDrawingsList.appendChild(li);
  }

  for (const t of trendlines) {
    const isSelected =
      state.selectedDrawing &&
      state.selectedDrawing.type === "trendline" &&
      state.selectedDrawing.id === t.id;

    const li = document.createElement("li");
    li.className = `drawing-item trendline ${isSelected ? "selected" : ""}`;
    li.style.borderLeftColor = t.color || "#22c55e";
    li.innerHTML = `
      <span>╱ Tend: $${Number(t.price1).toFixed(1)} → $${Number(t.price2).toFixed(1)}</span>
      <div class="drawing-item-actions">
        <button class="drawing-edit-btn" title="Editar línea">✎</button>
        <button class="drawing-delete-btn" title="Eliminar línea">🗑</button>
      </div>
    `;
    li.addEventListener("click", () => selectDrawing("trendline", t.id));
    li.querySelector(".drawing-edit-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      selectDrawing("trendline", t.id);
    });
    li.querySelector(".drawing-delete-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteDrawing("trendline", t.id);
    });
    elDrawingsList.appendChild(li);
  }

  for (const f of fibonaccis) {
    const isSelected =
      state.selectedDrawing &&
      state.selectedDrawing.type === "fibonacci" &&
      state.selectedDrawing.id === f.id;

    const li = document.createElement("li");
    li.className = `drawing-item fibonacci ${isSelected ? "selected" : ""}`;
    li.style.borderLeftColor = f.color || "#eab308";
    li.innerHTML = `
      <span>📐 Fib: $${Number(f.price1).toFixed(1)} → $${Number(f.price2).toFixed(1)}</span>
      <div class="drawing-item-actions">
        <button class="drawing-edit-btn" title="Editar Fibonacci">✎</button>
        <button class="drawing-delete-btn" title="Eliminar Fibonacci">🗑</button>
      </div>
    `;
    li.addEventListener("click", () => selectDrawing("fibonacci", f.id));
    li.querySelector(".drawing-edit-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      selectDrawing("fibonacci", f.id);
    });
    li.querySelector(".drawing-delete-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteDrawing("fibonacci", f.id);
    });
    elDrawingsList.appendChild(li);
  }
}

function deleteDrawing(type, id) {
  if (type === "horizontal") {
    state.annotations.horizontals = state.annotations.horizontals.filter(
      (h) => h.id !== id
    );
    const priceLine = priceLineRefs.get(id);
    if (priceLine) {
      candleSeries.removePriceLine(priceLine);
      priceLineRefs.delete(id);
    }
  } else if (type === "fibonacci") {
    state.annotations.fibonaccis = state.annotations.fibonaccis.filter(
      (f) => f.id !== id
    );
  } else if (type === "measure") {
    state.annotations.measures = (state.annotations.measures || []).filter(
      (m) => m.id !== id
    );
  } else {
    state.annotations.trendlines = state.annotations.trendlines.filter(
      (t) => t.id !== id
    );
  }

  if (
    state.selectedDrawing &&
    state.selectedDrawing.type === type &&
    state.selectedDrawing.id === id
  ) {
    state.selectedDrawing = null;
    elSelectedBar.classList.add("hidden");
  }

  renderOverlayHandles();
  renderDrawingsSidebarList();
  saveAnnotations();
}

async function saveAnnotations() {
  if (!state.activeTicker) return;

  elSaveStatus.textContent = "Guardando...";
  elSaveStatus.classList.add("saving");

  const payload = {
    notes: elTickerNotes.value,
    horizontals: state.annotations.horizontals,
    trendlines: state.annotations.trendlines,
    fibonaccis: state.annotations.fibonaccis,
    measures: state.annotations.measures || [],
  };

  try {
    const res = await fetch(
      `${API_BASE}/api/annotations/${encodeURIComponent(state.activeTicker)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    if (!res.ok) throw new Error("Error al guardar en SQLite");

    elSaveStatus.textContent = "Guardado en SQLite";
    elSaveStatus.classList.remove("saving");
  } catch (err) {
    console.error(err);
    elSaveStatus.textContent = "Error al guardar";
  }
}

// ============================================================================
// 7. EVENT LISTENERS DE LA INTERFAZ, PRESETS Y TEMPORALIDADES
// ============================================================================

// Selector de Temporalidad (1D, 1W, 1M)
document.querySelectorAll(".tf-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tf = btn.dataset.tf;
    if (!tf || tf === state.timeframe) return;
    state.timeframe = tf;
    document.querySelectorAll(".tf-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tf === tf);
    });
    if (state.activeTicker) {
      selectTicker(state.activeTicker, false);
    }
  });
});

// Botón de Full Sync (Anti-Splits/Dividendos)
btnFullSync.addEventListener("click", runFullSync);

// Modos de dibujo
btnModeCursor.addEventListener("click", () => setDrawingMode("cursor"));
btnModeTrendline.addEventListener("click", () => setDrawingMode("trendline"));
btnModeHorizontal.addEventListener("click", () => setDrawingMode("horizontal"));
btnModeFibonacci.addEventListener("click", () => setDrawingMode("fibonacci"));
btnModeMeasure.addEventListener("click", () => setDrawingMode("measure"));

// Presets de Medias Móviles
function applyMaVisibility({ ema9, ema21, ema50, ema100, ema200, sma200, wma200 }) {
  toggleEma9.checked = ema9;
  toggleEma21.checked = ema21;
  toggleEma50.checked = ema50;
  if (toggleEma100) toggleEma100.checked = ema100;
  toggleEma200.checked = ema200;
  if (toggleSma200) toggleSma200.checked = sma200;
  toggleWma200.checked = wma200;

  ema9Series.applyOptions({ visible: ema9 });
  ema21Series.applyOptions({ visible: ema21 });
  ema50Series.applyOptions({ visible: ema50 });
  if (ema100Series) ema100Series.applyOptions({ visible: ema100 });
  ema200Series.applyOptions({ visible: ema200 });
  if (sma200Series) sma200Series.applyOptions({ visible: sma200 });
  wma200Series.applyOptions({ visible: wma200 });
}

// "⚡ Vista Swing": Activa solo EMA 9, EMA 21 y EMA 50
btnPresetSwing.addEventListener("click", () => {
  applyMaVisibility({
    ema9: true,
    ema21: true,
    ema50: true,
    ema100: false,
    ema200: false,
    sma200: false,
    wma200: false,
  });
});

// "🏛️ Vista Posicional": Activa EMA 50, EMA 100, EMA 200, SMA 200 y WMA 200
btnPresetPositional.addEventListener("click", () => {
  applyMaVisibility({
    ema9: false,
    ema21: false,
    ema50: true,
    ema100: true,
    ema200: true,
    sma200: true,
    wma200: true,
  });
});

// Checkboxes individuales de Medias Móviles
toggleEma9.addEventListener("change", (e) => {
  ema9Series.applyOptions({ visible: e.target.checked });
});
toggleEma21.addEventListener("change", (e) => {
  ema21Series.applyOptions({ visible: e.target.checked });
});
toggleEma50.addEventListener("change", (e) => {
  ema50Series.applyOptions({ visible: e.target.checked });
});
toggleEma100.addEventListener("change", (e) => {
  ema100Series.applyOptions({ visible: e.target.checked });
});
toggleEma200.addEventListener("change", (e) => {
  ema200Series.applyOptions({ visible: e.target.checked });
});
toggleSma200.addEventListener("change", (e) => {
  sma200Series.applyOptions({ visible: e.target.checked });
});
toggleWma200.addEventListener("change", (e) => {
  wma200Series.applyOptions({ visible: e.target.checked });
});

// Eventos de la barra flotante de edición de dibujo seleccionado
elColorPicker.querySelectorAll(".color-dot").forEach((btn) => {
  btn.addEventListener("click", () => {
    const item = getSelectedItem();
    if (!item || !state.selectedDrawing) return;

    item.color = btn.dataset.color;
    if (state.selectedDrawing.type === "horizontal") {
      const priceLine = priceLineRefs.get(item.id);
      if (priceLine) priceLine.applyOptions({ color: item.color });
    }
    updateSelectedDrawingToolbar();
    renderOverlayHandles();
    renderDrawingsSidebarList();
    saveAnnotations();
  });
});

elEditHorizPrice.addEventListener("change", () => {
  const item = getSelectedItem();
  if (!item || !state.selectedDrawing || state.selectedDrawing.type !== "horizontal") return;
  const val = parseFloat(elEditHorizPrice.value);
  if (!isNaN(val)) {
    item.price = Number(val.toFixed(2));
    const priceLine = priceLineRefs.get(item.id);
    if (priceLine) priceLine.applyOptions({ price: item.price });
    renderOverlayHandles();
    renderDrawingsSidebarList();
    saveAnnotations();
  }
});

elEditHorizTitle.addEventListener("input", () => {
  const item = getSelectedItem();
  if (!item || !state.selectedDrawing || state.selectedDrawing.type !== "horizontal") return;
  item.title = elEditHorizTitle.value.trim() || "S/R";
  const priceLine = priceLineRefs.get(item.id);
  if (priceLine) priceLine.applyOptions({ title: item.title });
  renderDrawingsSidebarList();
  saveAnnotations();
});

elEditTrendP1.addEventListener("change", () => {
  const item = getSelectedItem();
  if (!item || !state.selectedDrawing || state.selectedDrawing.type === "horizontal") return;
  const val = parseFloat(elEditTrendP1.value);
  if (!isNaN(val)) {
    item.price1 = Number(val.toFixed(2));
    renderOverlayHandles();
    renderDrawingsSidebarList();
    saveAnnotations();
  }
});

elEditTrendP2.addEventListener("change", () => {
  const item = getSelectedItem();
  if (!item || !state.selectedDrawing || state.selectedDrawing.type === "horizontal") return;
  const val = parseFloat(elEditTrendP2.value);
  if (!isNaN(val)) {
    item.price2 = Number(val.toFixed(2));
    renderOverlayHandles();
    renderDrawingsSidebarList();
    saveAnnotations();
  }
});

btnDeleteSelected.addEventListener("click", () => {
  if (!state.selectedDrawing) return;
  deleteDrawing(state.selectedDrawing.type, state.selectedDrawing.id);
});

btnCloseSelected.addEventListener("click", () => {
  deselectDrawing();
});

// Arrastre libre de la barra flotante (#selected-drawing-bar)
function initFloatingSelectedBar() {
  if (!elSelectedBar) return;
  const pane = elSelectedBar.parentElement;
  if (!pane) return;

  // Restaurar posición previa si el usuario ya la movió
  try {
    const saved = JSON.parse(localStorage.getItem("caseritoview_floating_bar_pos") || "null");
    if (saved && typeof saved.left === "number" && typeof saved.top === "number") {
      elSelectedBar.style.right = "auto";
      elSelectedBar.style.left = `${Math.max(8, saved.left)}px`;
      elSelectedBar.style.top = `${Math.max(8, saved.top)}px`;
    }
  } catch (_) {}

  let barDrag = null;

  elSelectedBar.addEventListener("mousedown", (e) => {
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "BUTTON" || e.target.closest("button") || e.target.closest("input")) {
      return;
    }
    e.stopPropagation();
    e.preventDefault();

    const paneRect = pane.getBoundingClientRect();
    const barRect = elSelectedBar.getBoundingClientRect();

    barDrag = {
      offsetX: e.clientX - barRect.left,
      offsetY: e.clientY - barRect.top,
      paneWidth: paneRect.width,
      paneHeight: paneRect.height,
      barWidth: barRect.width,
      barHeight: barRect.height,
    };
    elSelectedBar.classList.add("dragging-bar");
  });

  window.addEventListener("mousemove", (e) => {
    if (!barDrag) return;
    const paneRect = pane.getBoundingClientRect();
    const maxLeft = Math.max(8, paneRect.width - barDrag.barWidth - 8);
    const maxTop = Math.max(8, paneRect.height - barDrag.barHeight - 8);

    const newLeft = Math.min(maxLeft, Math.max(8, e.clientX - paneRect.left - barDrag.offsetX));
    const newTop = Math.min(maxTop, Math.max(8, e.clientY - paneRect.top - barDrag.offsetY));

    elSelectedBar.style.right = "auto";
    elSelectedBar.style.left = `${newLeft}px`;
    elSelectedBar.style.top = `${newTop}px`;
  });

  window.addEventListener("mouseup", () => {
    if (!barDrag) return;
    barDrag = null;
    elSelectedBar.classList.remove("dragging-bar");
    try {
      localStorage.setItem(
        "caseritoview_floating_bar_pos",
        JSON.stringify({
          left: parseFloat(elSelectedBar.style.left) || 8,
          top: parseFloat(elSelectedBar.style.top) || 8,
        })
      );
    } catch (_) {}
  });
}

btnClearAll.addEventListener("click", () => {
  if (!state.activeTicker) return;
  const total =
    state.annotations.horizontals.length +
    state.annotations.trendlines.length +
    state.annotations.fibonaccis.length +
    (state.annotations.measures || []).length;
  if (total === 0) return;

  if (confirm(`¿Borrar todos los dibujos trazados en ${state.activeTicker}?`)) {
    cancelPendingDrawing();
    deselectDrawing();
    state.annotations.horizontals = [];
    state.annotations.trendlines = [];
    state.annotations.fibonaccis = [];
    state.annotations.measures = [];
    clearVisualDrawingsFromChart();
    renderDrawingsSidebarList();
    saveAnnotations();
  }
});

// Guardado automático (con debounce) y manual de las notas de texto
elTickerNotes.addEventListener("input", () => {
  state.annotations.notes = elTickerNotes.value;
  elSaveStatus.textContent = "Escribiendo...";
  elSaveStatus.classList.add("saving");

  if (notesDebounceTimer) clearTimeout(notesDebounceTimer);
  notesDebounceTimer = setTimeout(() => {
    saveAnnotations();
  }, 700);
});

elBtnSaveNotes.addEventListener("click", () => {
  if (notesDebounceTimer) clearTimeout(notesDebounceTimer);
  saveAnnotations();
});

// Agregar / consultar un ticker personalizado desde la barra lateral
elCustomTickerForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const val = elCustomTickerInput.value.trim().toUpperCase();
  if (val) {
    elCustomTickerInput.value = "";
    selectTicker(val);
  }
});

// Buscador en vivo de la Watchlist
if (elTickerSearchInput) {
  elTickerSearchInput.addEventListener("input", () => {
    state.tickerSearchQuery = elTickerSearchInput.value;
    if (elBtnClearSearch) {
      elBtnClearSearch.classList.toggle("hidden", !state.tickerSearchQuery.trim());
    }
    renderTickerList();
  });

  elTickerSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const query = (state.tickerSearchQuery || "").trim().toUpperCase();
      if (!query) return;
      const match = state.tickers.find((t) => t.toUpperCase().includes(query));
      if (match) {
        selectTicker(match);
      }
    } else if (e.key === "Escape") {
      state.tickerSearchQuery = "";
      elTickerSearchInput.value = "";
      if (elBtnClearSearch) elBtnClearSearch.classList.add("hidden");
      renderTickerList();
      elTickerSearchInput.blur();
    }
  });
}

if (elBtnClearSearch) {
  elBtnClearSearch.addEventListener("click", () => {
    state.tickerSearchQuery = "";
    if (elTickerSearchInput) {
      elTickerSearchInput.value = "";
      elTickerSearchInput.focus();
    }
    elBtnClearSearch.classList.add("hidden");
    renderTickerList();
  });
}

// Divisores arrastrables para ajustar el tamaño de la Watchlist, Dibujos Activos, Bitácora y el ancho de la barra lateral
function initSidebarResizers() {
  if (!elSidebar || !elWatchlistSection || !elDrawingsSection || !elNotesSection) return;

  // 1. Restaurar tamaños guardados en localStorage
  try {
    const saved = JSON.parse(localStorage.getItem("caseritoview_sidebar_layout") || "null");
    if (saved) {
      if (typeof saved.sidebarWidth === "number") {
        elSidebar.style.width = `${Math.min(520, Math.max(240, saved.sidebarWidth))}px`;
      }
      if (typeof saved.watchlistHeight === "number") {
        elWatchlistSection.style.height = `${Math.max(110, saved.watchlistHeight)}px`;
      }
      if (typeof saved.drawingsHeight === "number") {
        elDrawingsSection.style.height = `${Math.max(68, saved.drawingsHeight)}px`;
      }
    }
  } catch (_) {}

  const persistSidebarLayout = () => {
    try {
      localStorage.setItem(
        "caseritoview_sidebar_layout",
        JSON.stringify({
          sidebarWidth: elSidebar.getBoundingClientRect().width,
          watchlistHeight: elWatchlistSection.getBoundingClientRect().height,
          drawingsHeight: elDrawingsSection.getBoundingClientRect().height,
        })
      );
    } catch (_) {}
  };

  let activeResize = null;

  if (elResizerWatchlist) {
    elResizerWatchlist.addEventListener("mousedown", (e) => {
      e.preventDefault();
      activeResize = {
        type: "watchlist",
        startY: e.clientY,
        startWatchlistH: elWatchlistSection.getBoundingClientRect().height,
        startDrawingsH: elDrawingsSection.getBoundingClientRect().height,
        startNotesH: elNotesSection.getBoundingClientRect().height,
      };
      elResizerWatchlist.classList.add("resizing");
      document.body.style.cursor = "row-resize";
    });
  }

  if (elResizerDrawings) {
    elResizerDrawings.addEventListener("mousedown", (e) => {
      e.preventDefault();
      activeResize = {
        type: "drawings",
        startY: e.clientY,
        startDrawingsH: elDrawingsSection.getBoundingClientRect().height,
        startNotesH: elNotesSection.getBoundingClientRect().height,
      };
      elResizerDrawings.classList.add("resizing");
      document.body.style.cursor = "row-resize";
    });
  }

  if (elSidebarWidthResizer) {
    elSidebarWidthResizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      activeResize = {
        type: "width",
        startX: e.clientX,
        startWidth: elSidebar.getBoundingClientRect().width,
      };
      elSidebarWidthResizer.classList.add("resizing");
      document.body.style.cursor = "col-resize";
    });
  }

  window.addEventListener("mousemove", (e) => {
    if (!activeResize) return;

    if (activeResize.type === "watchlist") {
      const dy = e.clientY - activeResize.startY;
      const minWatchlistH = 110;
      const minDrawingsH = 68;
      const minNotesH = 85;

      // Espacio máximo que puede crecer la Watchlist achicando Bitácora y Dibujos Activos
      const maxGrowFromNotes = Math.max(0, activeResize.startNotesH - minNotesH);
      const maxGrowFromDrawings = Math.max(0, activeResize.startDrawingsH - minDrawingsH);
      const maxWatchlistH =
        activeResize.startWatchlistH + maxGrowFromNotes + maxGrowFromDrawings;

      const newWatchlistH = Math.min(
        maxWatchlistH,
        Math.max(minWatchlistH, activeResize.startWatchlistH + dy)
      );
      elWatchlistSection.style.height = `${newWatchlistH}px`;

      // Si ya se achicó la Bitácora al mínimo y el usuario sigue estirando la Watchlist, achicamos Dibujos Activos
      const actualGrow = newWatchlistH - activeResize.startWatchlistH;
      if (actualGrow > maxGrowFromNotes) {
        const overflowIntoDrawings = actualGrow - maxGrowFromNotes;
        elDrawingsSection.style.height = `${Math.max(
          minDrawingsH,
          activeResize.startDrawingsH - overflowIntoDrawings
        )}px`;
      } else {
        elDrawingsSection.style.height = `${activeResize.startDrawingsH}px`;
      }
    } else if (activeResize.type === "drawings") {
      const dy = e.clientY - activeResize.startY;
      const minDrawingsH = 68;
      const minNotesH = 85;
      const maxDrawingsH =
        activeResize.startDrawingsH + Math.max(0, activeResize.startNotesH - minNotesH);
      const newDrawingsH = Math.min(
        maxDrawingsH,
        Math.max(minDrawingsH, activeResize.startDrawingsH + dy)
      );
      elDrawingsSection.style.height = `${newDrawingsH}px`;
    } else if (activeResize.type === "width") {
      const dx = e.clientX - activeResize.startX;
      const newWidth = Math.min(520, Math.max(240, activeResize.startWidth + dx));
      elSidebar.style.width = `${newWidth}px`;
    }
  });

  window.addEventListener("mouseup", () => {
    if (!activeResize) return;
    activeResize = null;
    if (elResizerWatchlist) elResizerWatchlist.classList.remove("resizing");
    if (elResizerDrawings) elResizerDrawings.classList.remove("resizing");
    if (elSidebarWidthResizer) elSidebarWidthResizer.classList.remove("resizing");
    document.body.style.cursor = "";
    persistSidebarLayout();
  });
}

// Atajos de teclado: Escape para cancelar/deseleccionar, Delete/Backspace para borrar el dibujo seleccionado
window.addEventListener("keydown", (e) => {
  const tag = document.activeElement ? document.activeElement.tagName : "";
  const isTyping = tag === "INPUT" || tag === "TEXTAREA";

  if (e.key === "Escape") {
    if (state.pendingPoint) {
      cancelPendingDrawing();
      showHint("Trazado cancelado. Hacé click en el Punto 1 para iniciar de nuevo.");
    } else if (state.selectedDrawing) {
      deselectDrawing();
    } else {
      setDrawingMode("cursor");
    }
  } else if (
    (e.key === "Delete" || e.key === "Backspace") &&
    !isTyping &&
    state.selectedDrawing
  ) {
    e.preventDefault();
    deleteDrawing(state.selectedDrawing.type, state.selectedDrawing.id);
  }
});

// Inicializar aplicación al cargar el DOM
window.addEventListener("DOMContentLoaded", () => {
  initCharts();
  initFloatingSelectedBar();
  initSidebarResizers();
  fetchTickers();
});
