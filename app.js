'use strict';

/* ---------- Data fetching (CoinGecko public API, no key, CORS-enabled) ---------- */

async function fetchPrices(coinId, days) {
  const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  let res = await fetch(url);
  if (res.status === 429) {
    // free public tier rate-limits per IP; a single retry covers the common
    // case of a visitor switching assets quickly.
    await new Promise(r => setTimeout(r, 1500));
    res = await fetch(url);
  }
  if (!res.ok) throw new Error('API error ' + res.status);
  const json = await res.json();
  const prices = Array.isArray(json.prices) ? json.prices : [];

  // CoinGecko appends a final "right now" point that can share its calendar
  // date with the previous entry (e.g. one at 00:00 UTC, one at the current
  // hour) — collapse same-day points, keeping the latest price for that day.
  const dates = [];
  const closes = [];
  for (const [ts, price] of prices) {
    const date = new Date(ts).toISOString().slice(0, 10);
    if (dates.length && dates[dates.length - 1] === date) {
      closes[closes.length - 1] = price;
    } else {
      dates.push(date);
      closes.push(price);
    }
  }
  return { dates, closes };
}

/* ---------- Data fetching (Twelve Data — stocks/indices/commodities) ---------- */

// La clave YA NO vive aquí. Vivió incrustada en este fichero hasta que el
// proyecto hermano (PathFolio) estableció el patrón correcto: un Cloudflare
// Worker propio que la guarda como secreto de servidor y nunca la sirve al
// cliente. Este proyecto lo adoptó después — ver worker/README.md. La URL del
// proxy vive en config.js, no aquí, para que cambiar de despliegue no
// obligue a tocar la lógica.
const dataProxyUrl = () => (window.BACKTESTER_CONFIG && window.BACKTESTER_CONFIG.dataProxyUrl) || '';

// Curated, not searched: Twelve Data's free tier doesn't include a market-cap-
// ranked symbol list, and dynamically listing thousands of tickers would burn
// through the per-minute quota just to populate a dropdown. Indices and several
// commodities require a paid plan as direct symbols, so those are served via
// well-known ETF proxies instead — labeled as such, not hidden.
const ASSET_CATALOG = {
  stocks: [
    ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['GOOGL', 'Alphabet (Google)'], ['AMZN', 'Amazon'],
    ['NVDA', 'NVIDIA'], ['META', 'Meta Platforms'], ['TSLA', 'Tesla'], ['JPM', 'JPMorgan Chase'],
    ['V', 'Visa'], ['WMT', 'Walmart'], ['JNJ', 'Johnson & Johnson'], ['PG', 'Procter & Gamble'],
    ['XOM', 'Exxon Mobil'], ['KO', 'Coca-Cola'], ['DIS', 'Disney'], ['NFLX', 'Netflix'],
    ['AMD', 'AMD'], ['INTC', 'Intel'], ['BA', 'Boeing'], ['NKE', 'Nike'],
    ['PFE', 'Pfizer'], ['CSCO', 'Cisco'], ['ORCL', 'Oracle'], ['ADBE', 'Adobe'], ['CRM', 'Salesforce'],
  ],
  indices: [
    ['SPY', 'S&P 500 (vía ETF SPY)'], ['QQQ', 'Nasdaq 100 (vía ETF QQQ)'],
    ['DIA', 'Dow Jones (vía ETF DIA)'], ['IWM', 'Russell 2000 (vía ETF IWM)'],
  ],
  commodities: [
    ['GLD', 'Oro (vía ETF GLD)'], ['SLV', 'Plata (vía ETF SLV)'], ['USO', 'Petróleo WTI (vía ETF USO)'],
    ['UNG', 'Gas natural (vía ETF UNG)'], ['DBA', 'Agricultura (vía ETF DBA)'], ['DBC', 'Commodities amplio (vía ETF DBC)'],
  ],
};

async function fetchPricesTwelveData(symbol, outputsize) {
  const proxy = dataProxyUrl();
  if (!proxy) {
    // Sin proxy no hay de dónde sacar los datos, y la alternativa sería volver
    // a incrustar una credencial en el cliente. Mejor fallar diciendo qué falta.
    throw new Error('No hay proxy de datos configurado (config.js -> dataProxyUrl). Ver worker/README.md.');
  }
  const url = `${proxy.replace(/\/$/, '')}?symbol=${encodeURIComponent(symbol)}&outputsize=${outputsize}`;
  let res = await fetch(url);
  let json = await res.json();
  if (json.status === 'error' && json.code === 429) {
    // free tier is limited per MINUTE, not per second — worth a real wait.
    await new Promise(r => setTimeout(r, 8000));
    res = await fetch(url);
    json = await res.json();
  }
  if (!res.ok || json.status === 'error') {
    throw new Error(json.message || ('API error ' + res.status));
  }
  const values = Array.isArray(json.values) ? json.values : [];
  const chronological = values.slice().reverse(); // Twelve Data returns newest-first
  const dates = chronological.map(v => v.datetime);
  const closes = chronological.map(v => parseFloat(v.close));
  return { dates, closes };
}

/* ---------- Strategy math ----------
   sma(), backtest(), simulateManualTrade() y las dos funciones del
   comparador evergreen viven ahora en engine.js, cargado antes que este
   fichero (ver index.html) — no toca el DOM y así las pruebas importan
   exactamente el mismo código que corre en producción, en vez de una
   copia que se pueda desincronizar. ---------- */


/* ---------- Formatting ---------- */

function formatUSD(v) {
  if (v == null || Number.isNaN(v)) return '—';
  const decimals = v < 1 ? 4 : v < 100 ? 2 : 0;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatSignedUSD(v) {
  if (v == null || Number.isNaN(v)) return '—';
  const sign = v < 0 ? '-' : v > 0 ? '+' : '';
  const abs = Math.abs(v);
  const decimals = abs < 100 ? 2 : 0;
  return sign + '$' + abs.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatPct(v) {
  if (v == null || Number.isNaN(v)) return '—';
  const pct = v * 100;
  const sign = pct > 0 ? '+' : '';
  return sign + pct.toFixed(2) + '%';
}

function shortDate(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/* ---------- Chart rendering (hand-rolled SVG, no dependency) ---------- */

const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

function buildTooltip(tooltipEl, dateLabel, rows) {
  tooltipEl.textContent = '';
  const dateDiv = document.createElement('div');
  dateDiv.className = 'tt-date';
  dateDiv.textContent = dateLabel;
  tooltipEl.appendChild(dateDiv);
  rows.forEach(r => {
    const row = document.createElement('div');
    row.className = 'tt-row';
    const key = document.createElement('span');
    key.className = 'tt-key';
    key.style.background = r.color;
    const name = document.createElement('span');
    name.className = 'tt-name';
    name.textContent = r.name;
    const val = document.createElement('span');
    val.className = 'tt-val';
    val.textContent = r.value;
    row.append(key, name, val);
    tooltipEl.appendChild(row);
  });
}

function buildLegend(container, items) {
  container.textContent = '';
  items.forEach(item => {
    const el = document.createElement('span');
    el.className = 'legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch' + (item.type === 'marker' ? ' marker' : '');
    swatch.style.background = item.color;
    const label = document.createElement('span');
    label.textContent = item.name;
    el.append(swatch, label);
    container.appendChild(el);
  });
}

function renderChart({ svg, tooltipEl, dates, series, markers, pointMarkers, hLines, onPointClick, yFormat, tooltipFormat }) {
  const rect = svg.getBoundingClientRect();
  const width = Math.max(300, rect.width);
  const height = 320;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const margin = { top: 14, right: 16, bottom: 26, left: 60 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const n = dates.length;

  const allY = series.flatMap(s => s.data.filter(v => v != null));
  let yMin = Math.min(...allY), yMax = Math.max(...allY);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const pad = (yMax - yMin) * 0.08;
  yMin -= pad; yMax += pad;

  const xForIndex = i => margin.left + (n <= 1 ? 0 : (i / (n - 1)) * innerW);
  const yForValue = v => margin.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  // gridlines + y ticks
  const yTicks = 4;
  for (let t = 0; t <= yTicks; t++) {
    const v = yMin + (yMax - yMin) * (t / yTicks);
    const y = yForValue(v);
    svg.appendChild(svgEl('line', { x1: margin.left, x2: width - margin.right, y1: y, y2: y, stroke: 'var(--gridline)', 'stroke-width': 1 }));
    const label = svgEl('text', { x: margin.left - 8, y: y + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--text-muted)' });
    label.textContent = yFormat(v);
    svg.appendChild(label);
  }

  // baseline
  svg.appendChild(svgEl('line', { x1: margin.left, x2: width - margin.right, y1: margin.top + innerH, y2: margin.top + innerH, stroke: 'var(--baseline)', 'stroke-width': 1 }));

  // reference horizontal lines (e.g. liquidation price)
  if (hLines) {
    hLines.forEach(hl => {
      if (hl.value < yMin || hl.value > yMax) return;
      const y = yForValue(hl.value);
      svg.appendChild(svgEl('line', { x1: margin.left, x2: width - margin.right, y1: y, y2: y, stroke: hl.color, 'stroke-width': 1.5, 'stroke-dasharray': '5,4' }));
      if (hl.label) {
        const label = svgEl('text', { x: width - margin.right, y: y - 5, 'text-anchor': 'end', 'font-size': 11, fill: hl.color });
        label.textContent = hl.label;
        svg.appendChild(label);
      }
    });
  }

  // x ticks
  const xTickCount = Math.min(6, n);
  for (let t = 0; t < xTickCount; t++) {
    const idx = Math.round((t / (xTickCount - 1 || 1)) * (n - 1));
    const x = xForIndex(idx);
    const label = svgEl('text', { x, y: height - 6, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--text-muted)' });
    label.textContent = shortDate(dates[idx]);
    svg.appendChild(label);
  }

  // series lines
  series.forEach(s => {
    let d = '';
    s.data.forEach((v, i) => {
      if (v == null) return;
      d += (d === '' ? 'M' : 'L') + xForIndex(i).toFixed(2) + ',' + yForValue(v).toFixed(2) + ' ';
    });
    svg.appendChild(svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  });

  // buy/sell markers
  if (markers) {
    markers.forEach(m => {
      const x = xForIndex(m.index), y = yForValue(m.y), size = 7;
      const color = m.type === 'buy' ? 'var(--status-good)' : 'var(--status-critical)';
      const points = m.type === 'buy'
        ? `${x},${y - size} ${x - size},${y + size} ${x + size},${y + size}`
        : `${x - size},${y - size} ${x + size},${y - size} ${x},${y + size}`;
      svg.appendChild(svgEl('polygon', { points, fill: color, stroke: 'var(--surface-1)', 'stroke-width': 2 }));
    });
  }

  // manual-sim entry/exit markers (shape-differentiated, neutral ink — kept
  // out of the categorical hues so they never compete with the price/SMA series)
  if (pointMarkers) {
    pointMarkers.forEach(m => {
      const x = xForIndex(m.index), y = yForValue(m.y), s = 8;
      if (m.shape === 'entry') {
        svg.appendChild(svgEl('rect', { x: x - s, y: y - s, width: s * 2, height: s * 2, fill: 'var(--text-primary)', stroke: 'var(--surface-1)', 'stroke-width': 2 }));
      } else {
        const points = `${x},${y - s * 1.2} ${x + s * 1.2},${y} ${x},${y + s * 1.2} ${x - s * 1.2},${y}`;
        svg.appendChild(svgEl('polygon', { points, fill: 'var(--text-primary)', stroke: 'var(--surface-1)', 'stroke-width': 2 }));
      }
    });
  }

  // hover layer
  const crosshair = svgEl('line', { x1: 0, x2: 0, y1: margin.top, y2: margin.top + innerH, stroke: 'var(--baseline)', 'stroke-width': 1, visibility: 'hidden' });
  svg.appendChild(crosshair);
  const dots = series.map(s => {
    const d = svgEl('circle', { r: 4, fill: s.color, stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden' });
    svg.appendChild(d);
    return d;
  });
  const hitRect = svgEl('rect', { x: margin.left, y: margin.top, width: Math.max(innerW, 0), height: Math.max(innerH, 0), fill: 'transparent' });
  svg.appendChild(hitRect);

  function handleMove(evt) {
    const svgRect = svg.getBoundingClientRect();
    if (svgRect.width === 0) return;
    const px = (evt.clientX - svgRect.left) * (width / svgRect.width);
    let idx = Math.round(((px - margin.left) / innerW) * (n - 1));
    idx = Math.max(0, Math.min(n - 1, idx));
    const x = xForIndex(idx);
    crosshair.setAttribute('x1', x);
    crosshair.setAttribute('x2', x);
    crosshair.setAttribute('visibility', 'visible');

    const rows = [];
    series.forEach((s, si) => {
      const v = s.data[idx];
      if (v == null) { dots[si].setAttribute('visibility', 'hidden'); return; }
      dots[si].setAttribute('cx', x);
      dots[si].setAttribute('cy', yForValue(v));
      dots[si].setAttribute('visibility', 'visible');
      rows.push({ name: s.name, color: s.color, value: (tooltipFormat || yFormat)(v) });
    });

    if (tooltipEl) {
      tooltipEl.hidden = false;
      const wrapRect = svg.parentElement.getBoundingClientRect();
      tooltipEl.style.left = (svgRect.left - wrapRect.left + x) + 'px';
      tooltipEl.style.top = (svgRect.top - wrapRect.top + margin.top) + 'px';
      buildTooltip(tooltipEl, dates[idx], rows);
    }
  }
  function handleLeave() {
    crosshair.setAttribute('visibility', 'hidden');
    dots.forEach(d => d.setAttribute('visibility', 'hidden'));
    if (tooltipEl) tooltipEl.hidden = true;
  }
  hitRect.addEventListener('pointermove', handleMove);
  hitRect.addEventListener('pointerleave', handleLeave);

  if (onPointClick) {
    hitRect.style.cursor = 'crosshair';
    hitRect.addEventListener('click', evt => {
      const svgRect = svg.getBoundingClientRect();
      if (svgRect.width === 0) return;
      const px = (evt.clientX - svgRect.left) * (width / svgRect.width);
      let idx = Math.round(((px - margin.left) / innerW) * (n - 1));
      idx = Math.max(0, Math.min(n - 1, idx));
      onPointClick(idx);
    });
  }
}

/* ---------- Asset list ---------- */

// index.html ships a small static <option> list as an instant, no-JS fallback.
// On load we replace it with the top ~150 assets by market cap, so the page
// never shows an empty dropdown even if this fetch is slow or rate-limited.
async function loadAssetOptions() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=150&page=1&sparkline=false');
    if (!res.ok) return;
    const coins = await res.json();
    if (!Array.isArray(coins) || !coins.length) return;

    const previousValue = assetSelect.value;
    assetSelect.textContent = '';
    coins.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.dataset.symbol = (c.symbol || '').toUpperCase();
      opt.textContent = `${c.name} (${(c.symbol || '').toUpperCase()})`;
      assetSelect.appendChild(opt);
    });

    if (coins.some(c => c.id === previousValue)) assetSelect.value = previousValue;
    else if (coins.some(c => c.id === 'bitcoin')) assetSelect.value = 'bitcoin';
  } catch (err) {
    console.error('No se pudo cargar la lista completa de activos, usando la lista reducida.', err);
  }
}

function populateStaticAssetOptions(type) {
  assetSelect.textContent = '';
  (ASSET_CATALOG[type] || []).forEach(([symbol, label]) => {
    const opt = document.createElement('option');
    opt.value = symbol;
    opt.dataset.symbol = symbol;
    opt.textContent = `${label} (${symbol})`;
    assetSelect.appendChild(opt);
  });
}

async function refreshAssetOptions(type) {
  if (type === 'crypto') await loadAssetOptions();
  else populateStaticAssetOptions(type);
}

/* ---------- Page wiring ---------- */

const assetTypeSelect = document.getElementById('assetType');
const assetSelect = document.getElementById('asset');
const rangeSelect = document.getElementById('range');
const shortInput = document.getElementById('smaShort');
const longInput = document.getElementById('smaLong');
const runBtn = document.getElementById('runBtn');
const statusEl = document.getElementById('status');

const simDirection = document.getElementById('simDirection');
const simLeverage = document.getElementById('simLeverage');
const simSize = document.getElementById('simSize');
const simCloseNowBtn = document.getElementById('simCloseNowBtn');
const simClearBtn = document.getElementById('simClearBtn');
const simStatusEl = document.getElementById('simStatus');
const simStatGrid = document.getElementById('simStatGrid');

const peLockup = document.getElementById('peLockup');
const pePremium = document.getElementById('pePremium');
const peExitRequest = document.getElementById('peExitRequest');
const peExitStatusEl = document.getElementById('peExitStatus');

let lastResult = null;
let manualSim = { entryIndex: null, exitIndex: null };

function setStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? 'var(--status-critical)' : '';
}

function setStat(key, text, sentiment) {
  const valueEl = document.querySelector(`.stat-tile[data-stat="${key}"] .stat-value`);
  valueEl.textContent = text;
  valueEl.classList.remove('positive', 'negative');
  if (sentiment) valueEl.classList.add(sentiment);
}

function setSimStat(key, text, sentiment) {
  const valueEl = document.querySelector(`#simStatGrid .stat-tile[data-stat="${key}"] .stat-value`);
  valueEl.textContent = text;
  valueEl.classList.remove('positive', 'negative');
  if (sentiment) valueEl.classList.add(sentiment);
}

function resetManualSim() {
  manualSim = { entryIndex: null, exitIndex: null };
  simStatusEl.textContent = 'Click en el gráfico de precio para elegir tu entrada.';
  simStatGrid.hidden = true;
}

function handleChartClick(idx) {
  if (!lastResult) return;
  if (manualSim.entryIndex == null) {
    manualSim.entryIndex = idx;
    manualSim.exitIndex = null;
  } else if (manualSim.exitIndex == null) {
    if (idx === manualSim.entryIndex) return;
    manualSim.exitIndex = Math.max(idx, manualSim.entryIndex);
    manualSim.entryIndex = Math.min(idx, manualSim.entryIndex);
  } else {
    manualSim.entryIndex = idx;
    manualSim.exitIndex = null;
  }
  updateManualSim();
}

function updateManualSim() {
  if (!lastResult) return;
  const r = lastResult;
  const sim = renderPriceChart(r);

  if (manualSim.entryIndex == null) {
    simStatusEl.textContent = 'Click en el gráfico de precio para elegir tu entrada.';
    simStatGrid.hidden = true;
    return;
  }
  if (sim == null) {
    simStatusEl.textContent = `Entrada: ${r.dates[manualSim.entryIndex]} @ ${formatUSD(r.closes[manualSim.entryIndex])}. Click de nuevo para la salida, o usa "Cerrar al final del rango".`;
    simStatGrid.hidden = true;
    return;
  }

  simStatGrid.hidden = false;
  setSimStat('simPnlUsd', formatSignedUSD(sim.pnlUsd), sim.pnlUsd >= 0 ? 'positive' : 'negative');
  setSimStat('simPnlPct', formatPct(sim.pnlPct), sim.pnlPct >= 0 ? 'positive' : 'negative');
  setSimStat('simMargin', formatUSD(sim.margin));
  setSimStat('simLiquidation', sim.leverage > 1 ? formatUSD(sim.liquidationPrice) : 'N/A (sin apalancar)');
  setSimStat('simDays', String(sim.daysHeld));

  simStatusEl.textContent = sim.liquidated
    ? `Posición liquidada el ${sim.exitDate} @ ${formatUSD(sim.exitPrice)} — se perdió el margen completo.`
    : `${sim.direction === 'long' ? 'Long' : 'Short'} de ${sim.entryDate} a ${sim.exitDate}: ${formatPct(sim.pnlPct)} sobre el margen.`;
}

function renderPriceChart(r) {
  const markers = r.trades.flatMap(t => {
    const m = [{ index: t.entryIndex, type: 'buy', y: t.entryPrice }];
    if (!t.openAtEnd) m.push({ index: t.exitIndex, type: 'sell', y: t.exitPrice });
    return m;
  });

  const pointMarkers = [];
  const hLines = [];
  let sim = null;
  if (manualSim.entryIndex != null) {
    pointMarkers.push({ index: manualSim.entryIndex, shape: 'entry', y: r.closes[manualSim.entryIndex] });
  }
  if (manualSim.entryIndex != null && manualSim.exitIndex != null) {
    const direction = simDirection.value;
    const leverage = Math.max(1, parseFloat(simLeverage.value) || 1);
    const sizeUsd = Math.max(0, parseFloat(simSize.value) || 0);
    sim = simulateManualTrade({
      dates: r.dates, closes: r.closes,
      entryIndex: manualSim.entryIndex, exitIndex: manualSim.exitIndex,
      direction, leverage, sizeUsd,
    });
    pointMarkers.push({ index: sim.exitIndex, shape: 'exit', y: sim.exitPrice });
    if (leverage > 1) hLines.push({ value: sim.liquidationPrice, color: 'var(--status-critical)', label: 'Liquidación' });
  }

  renderChart({
    svg: document.getElementById('priceChart'),
    tooltipEl: document.getElementById('priceTooltip'),
    dates: r.dates,
    series: [
      { name: 'Precio', color: 'var(--series-1)', data: r.closes },
      { name: `SMA ${r.shortP}`, color: 'var(--series-2)', data: r.smaShort },
      { name: `SMA ${r.longP}`, color: 'var(--series-3)', data: r.smaLong },
    ],
    markers,
    pointMarkers,
    hLines,
    onPointClick: handleChartClick,
    yFormat: formatUSD,
  });
  buildLegend(document.getElementById('priceLegend'), [
    { name: 'Precio', color: 'var(--series-1)', type: 'line' },
    { name: `SMA ${r.shortP}`, color: 'var(--series-2)', type: 'line' },
    { name: `SMA ${r.longP}`, color: 'var(--series-3)', type: 'line' },
    { name: 'Compra (estrategia)', color: 'var(--status-good)', type: 'marker' },
    { name: 'Venta (estrategia)', color: 'var(--status-critical)', type: 'marker' },
    { name: 'Tu entrada', color: 'var(--text-primary)', type: 'marker' },
    { name: 'Tu salida', color: 'var(--text-primary)', type: 'marker' },
  ]);

  return sim;
}

function updatePEComparator(r) {
  if (peExitRequest.min !== r.dates[0] || peExitRequest.max !== r.dates[r.dates.length - 1]) {
    peExitRequest.min = r.dates[0];
    peExitRequest.max = r.dates[r.dates.length - 1];
    peExitRequest.value = r.dates[Math.floor(r.dates.length / 2)];
  }

  const lockupMonths = Math.max(0, parseFloat(peLockup.value) || 0);
  const premiumAnnual = Math.max(0, parseFloat(pePremium.value) || 0) / 100;
  const barsPerYear = r.barsPerYear;

  const { reportedEquity, quarterlyReturns, quarterBars } = computeEvergreenSeries({ closes: r.closes, premiumAnnual, barsPerYear });

  const liquidDailyRets = [];
  for (let i = 1; i < r.closes.length; i++) liquidDailyRets.push((r.closes[i] - r.closes[i - 1]) / r.closes[i - 1]);

  const liquidReturn = r.buyHoldEquity[r.buyHoldEquity.length - 1] - 1;
  const evergreenReturn = reportedEquity[reportedEquity.length - 1] - 1;
  const liquidVol = annualizedVol(liquidDailyRets, barsPerYear);
  const reportedVol = annualizedVol(quarterlyReturns, barsPerYear / quarterBars);
  const liquidDD = maxDrawdown(r.buyHoldEquity);
  const reportedDD = maxDrawdown(reportedEquity);

  setStat('peLiquidReturn', formatPct(liquidReturn), liquidReturn >= 0 ? 'positive' : 'negative');
  setStat('peEvergreenReturn', formatPct(evergreenReturn), evergreenReturn >= 0 ? 'positive' : 'negative');
  setStat('peLiquidVol', formatPct(liquidVol));
  setStat('peReportedVol', formatPct(reportedVol));
  setStat('peLiquidDD', formatPct(liquidDD), 'negative');
  setStat('peReportedDD', formatPct(reportedDD), 'negative');

  const requestedDate = peExitRequest.value || r.dates[Math.floor(r.dates.length / 2)];
  const { requestedIndex, exitIndex, clampedByData } = computeExitAvailability({
    dates: r.dates, requestedDate, lockupMonths, barsPerYear, quarterBars,
  });
  const waitDays = exitIndex - requestedIndex;
  if (waitDays <= 0) {
    peExitStatusEl.textContent = `Pediste salir el ${r.dates[requestedIndex]} — coincide con (o cae después de) tu ventana de liquidez, así que podrías salir ese día.`;
  } else {
    peExitStatusEl.textContent = `Pediste salir el ${r.dates[requestedIndex]}. Con lock-up de ${lockupMonths} meses + ventanas trimestrales, tu salida real más temprana sería el ${r.dates[exitIndex]} — ${waitDays} días de espera adicionales.`
      + (clampedByData ? ' (Esto ya cae al final del rango de datos cargado; en la práctica esperarías incluso más.)' : '');
  }

  renderChart({
    svg: document.getElementById('peChart'),
    tooltipEl: document.getElementById('peTooltip'),
    dates: r.dates,
    series: [
      { name: 'Líquido (real)', color: 'var(--series-1)', data: r.buyHoldEquity.map(v => (v - 1) * 100) },
      { name: 'Evergreen (reportado)', color: 'var(--series-2)', data: reportedEquity.map(v => (v - 1) * 100) },
    ],
    yFormat: v => (v > 0 ? '+' : '') + v.toFixed(0) + '%',
    tooltipFormat: v => (v > 0 ? '+' : '') + v.toFixed(2) + '%',
  });
  buildLegend(document.getElementById('peLegend'), [
    { name: 'Líquido (real)', color: 'var(--series-1)', type: 'line' },
    { name: 'Evergreen (reportado)', color: 'var(--series-2)', type: 'line' },
  ]);
}

function renderAll(r) {
  const metrics = computeMetrics(r, r.barsPerYear);
  setStat('strategyReturn', formatPct(metrics.strategyReturn), metrics.strategyReturn >= 0 ? 'positive' : 'negative');
  setStat('buyHoldReturn', formatPct(metrics.buyHoldReturn), metrics.buyHoldReturn >= 0 ? 'positive' : 'negative');
  setStat('maxDrawdown', formatPct(metrics.maxDD), 'negative');
  setStat('sharpe', metrics.sharpe.toFixed(2));
  setStat('winRate', metrics.winRate == null ? '—' : (metrics.winRate * 100).toFixed(0) + '%');
  setStat('trades', String(metrics.tradeCount));

  renderPriceChart(r);

  renderChart({
    svg: document.getElementById('equityChart'),
    tooltipEl: document.getElementById('equityTooltip'),
    dates: r.dates,
    series: [
      { name: 'Estrategia', color: 'var(--series-1)', data: r.strategyEquity.map(v => (v - 1) * 100) },
      { name: 'Buy & hold', color: 'var(--series-2)', data: r.buyHoldEquity.map(v => (v - 1) * 100) },
    ],
    yFormat: v => (v > 0 ? '+' : '') + v.toFixed(0) + '%',
    tooltipFormat: v => (v > 0 ? '+' : '') + v.toFixed(2) + '%',
  });
  buildLegend(document.getElementById('equityLegend'), [
    { name: 'Estrategia', color: 'var(--series-1)', type: 'line' },
    { name: 'Buy & hold', color: 'var(--series-2)', type: 'line' },
  ]);

  updatePEComparator(r);
}

async function runBacktestFlow() {
  const assetType = assetTypeSelect.value;
  const assetId = assetSelect.value;
  const symbol = assetSelect.selectedOptions[0] ? assetSelect.selectedOptions[0].dataset.symbol : assetId;
  const days = rangeSelect.value;
  const shortP = parseInt(shortInput.value, 10);
  const longP = parseInt(longInput.value, 10);
  const barsPerYear = assetType === 'crypto' ? 365 : 252;

  if (!assetId) { setStatus('Elige un activo primero.', true); return; }
  if (!(shortP > 0) || !(longP > 0)) { setStatus('Los períodos deben ser números positivos.', true); return; }
  if (shortP >= longP) { setStatus('La SMA corta debe ser menor que la SMA larga.', true); return; }

  runBtn.disabled = true;
  setStatus('Descargando datos de mercado…');
  try {
    const { dates, closes } = assetType === 'crypto'
      ? await fetchPrices(assetId, days)
      : await fetchPricesTwelveData(assetId, days);
    if (closes.length < longP + 5) {
      setStatus(`Datos insuficientes (${closes.length} velas) para una SMA de ${longP}. Elige un rango mayor o períodos más cortos.`, true);
      return;
    }
    setStatus('Corriendo backtest…');
    const result = backtest(dates, closes, shortP, longP);
    lastResult = { dates, closes, shortP, longP, symbol, barsPerYear, ...result };
    resetManualSim();
    renderAll(lastResult);
    setStatus(`Listo — ${closes.length} velas de ${symbol}, del ${dates[0]} al ${dates[dates.length - 1]}.`);
  } catch (err) {
    console.error(err);
    setStatus('Error al descargar datos (posible límite de la API o símbolo no disponible en el tier gratuito). Intenta de nuevo en unos segundos.', true);
  } finally {
    runBtn.disabled = false;
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

runBtn.addEventListener('click', runBacktestFlow);
window.addEventListener('resize', debounce(() => { if (lastResult) renderAll(lastResult); }, 200));

[simDirection, simLeverage, simSize].forEach(el => el.addEventListener('input', updateManualSim));

simCloseNowBtn.addEventListener('click', () => {
  if (!lastResult || manualSim.entryIndex == null) {
    simStatusEl.textContent = 'Primero elige una entrada haciendo click en el gráfico de precio.';
    return;
  }
  manualSim.exitIndex = lastResult.dates.length - 1;
  updateManualSim();
});

simClearBtn.addEventListener('click', () => {
  resetManualSim();
  if (lastResult) renderPriceChart(lastResult);
});

[peLockup, pePremium, peExitRequest].forEach(el => el.addEventListener('input', () => {
  if (lastResult) updatePEComparator(lastResult);
}));

assetTypeSelect.addEventListener('change', () => {
  refreshAssetOptions(assetTypeSelect.value).finally(runBacktestFlow);
});

refreshAssetOptions(assetTypeSelect.value).finally(runBacktestFlow);
