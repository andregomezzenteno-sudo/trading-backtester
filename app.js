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

/* ---------- Strategy math ---------- */

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// SMA-crossover backtest. A cross detected using data through day i is only
// acted on at day i+1's close, so no decision ever uses same-bar information.
function backtest(dates, closes, shortP, longP) {
  const n = closes.length;
  const smaShort = sma(closes, shortP);
  const smaLong = sma(closes, longP);

  let position = null; // { entryIndex, entryDate, entryPrice }
  let pendingSignal = null; // 'buy' | 'sell', decided yesterday, executed today
  const trades = [];
  const strategyEquity = new Array(n).fill(1);
  const buyHoldEquity = new Array(n).fill(1);
  const dailyReturns = [];

  for (let i = 1; i < n; i++) {
    buyHoldEquity[i] = buyHoldEquity[i - 1] * (closes[i] / closes[i - 1]);

    // P&L for today's move belongs to whatever position we already held
    // coming INTO today — not a position opened at today's own close.
    const dayReturn = position ? (closes[i] - closes[i - 1]) / closes[i - 1] : 0;
    strategyEquity[i] = strategyEquity[i - 1] * (1 + dayReturn);
    dailyReturns.push(dayReturn);

    if (pendingSignal === 'buy' && !position) {
      position = { entryIndex: i, entryDate: dates[i], entryPrice: closes[i] };
    } else if (pendingSignal === 'sell' && position) {
      const exitPrice = closes[i];
      trades.push({
        entryIndex: position.entryIndex,
        entryDate: position.entryDate,
        entryPrice: position.entryPrice,
        exitIndex: i,
        exitDate: dates[i],
        exitPrice,
        returnPct: (exitPrice - position.entryPrice) / position.entryPrice,
        openAtEnd: false,
      });
      position = null;
    }
    pendingSignal = null;

    const a = smaShort[i - 1], b = smaLong[i - 1], c = smaShort[i], d = smaLong[i];
    if (a != null && b != null && c != null && d != null) {
      const prevDiff = a - b, currDiff = c - d;
      if (prevDiff <= 0 && currDiff > 0) pendingSignal = 'buy';
      else if (prevDiff >= 0 && currDiff < 0) pendingSignal = 'sell';
    }
  }

  if (position) {
    const exitPrice = closes[n - 1];
    trades.push({
      entryIndex: position.entryIndex,
      entryDate: position.entryDate,
      entryPrice: position.entryPrice,
      exitIndex: n - 1,
      exitDate: dates[n - 1],
      exitPrice,
      returnPct: (exitPrice - position.entryPrice) / position.entryPrice,
      openAtEnd: true,
    });
  }

  return { smaShort, smaLong, trades, strategyEquity, buyHoldEquity, dailyReturns };
}

function computeMetrics(r) {
  const n = r.closes.length;
  const strategyReturn = r.strategyEquity[n - 1] - 1;
  const buyHoldReturn = r.buyHoldEquity[n - 1] - 1;

  let peak = r.strategyEquity[0], maxDD = 0;
  for (const v of r.strategyEquity) {
    peak = Math.max(peak, v);
    maxDD = Math.min(maxDD, (v - peak) / peak);
  }

  const rets = r.dailyReturns;
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;

  const wins = r.trades.filter(t => t.returnPct > 0).length;
  const winRate = r.trades.length ? wins / r.trades.length : null;

  return { strategyReturn, buyHoldReturn, maxDD, sharpe, winRate, tradeCount: r.trades.length };
}

/* ---------- Formatting ---------- */

function formatUSD(v) {
  if (v == null || Number.isNaN(v)) return '—';
  const decimals = v < 1 ? 4 : v < 100 ? 2 : 0;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
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

function renderChart({ svg, tooltipEl, dates, series, markers, yFormat, tooltipFormat }) {
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

/* ---------- Page wiring ---------- */

const assetSelect = document.getElementById('asset');
const rangeSelect = document.getElementById('range');
const shortInput = document.getElementById('smaShort');
const longInput = document.getElementById('smaLong');
const runBtn = document.getElementById('runBtn');
const statusEl = document.getElementById('status');

let lastResult = null;

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

function renderTrades(trades, symbol) {
  const tbody = document.querySelector('#tradesTable tbody');
  const empty = document.getElementById('tradesEmpty');
  tbody.textContent = '';
  if (!trades.length) {
    empty.hidden = false;
    empty.textContent = 'No hubo cruces de medias en este rango — sin operaciones.';
    return;
  }
  empty.hidden = true;
  trades.forEach((t, i) => {
    const tr = document.createElement('tr');
    const cells = [
      String(i + 1),
      t.entryDate,
      formatUSD(t.entryPrice),
      t.exitDate + (t.openAtEnd ? ' (abierta)' : ''),
      formatUSD(t.exitPrice),
      formatPct(t.returnPct),
    ];
    cells.forEach((text, ci) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (ci >= 2) td.classList.add('num');
      if (ci === 5) td.classList.add(t.returnPct >= 0 ? 'positive' : 'negative');
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

function renderAll(r) {
  const metrics = computeMetrics(r);
  setStat('strategyReturn', formatPct(metrics.strategyReturn), metrics.strategyReturn >= 0 ? 'positive' : 'negative');
  setStat('buyHoldReturn', formatPct(metrics.buyHoldReturn), metrics.buyHoldReturn >= 0 ? 'positive' : 'negative');
  setStat('maxDrawdown', formatPct(metrics.maxDD), 'negative');
  setStat('sharpe', metrics.sharpe.toFixed(2));
  setStat('winRate', metrics.winRate == null ? '—' : (metrics.winRate * 100).toFixed(0) + '%');
  setStat('trades', String(metrics.tradeCount));

  const markers = r.trades.flatMap(t => {
    const m = [{ index: t.entryIndex, type: 'buy', y: t.entryPrice }];
    if (!t.openAtEnd) m.push({ index: t.exitIndex, type: 'sell', y: t.exitPrice });
    return m;
  });

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
    yFormat: formatUSD,
  });
  buildLegend(document.getElementById('priceLegend'), [
    { name: 'Precio', color: 'var(--series-1)', type: 'line' },
    { name: `SMA ${r.shortP}`, color: 'var(--series-2)', type: 'line' },
    { name: `SMA ${r.longP}`, color: 'var(--series-3)', type: 'line' },
    { name: 'Compra', color: 'var(--status-good)', type: 'marker' },
    { name: 'Venta', color: 'var(--status-critical)', type: 'marker' },
  ]);

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

  renderTrades(r.trades, r.symbol);
}

async function runBacktestFlow() {
  const coinId = assetSelect.value;
  const symbol = assetSelect.selectedOptions[0].dataset.symbol;
  const days = rangeSelect.value;
  const shortP = parseInt(shortInput.value, 10);
  const longP = parseInt(longInput.value, 10);

  if (!(shortP > 0) || !(longP > 0)) { setStatus('Los períodos deben ser números positivos.', true); return; }
  if (shortP >= longP) { setStatus('La SMA corta debe ser menor que la SMA larga.', true); return; }

  runBtn.disabled = true;
  setStatus('Descargando datos de mercado…');
  try {
    const { dates, closes } = await fetchPrices(coinId, days);
    if (closes.length < longP + 5) {
      setStatus(`Datos insuficientes (${closes.length} días) para una SMA de ${longP}. Elige un rango mayor o períodos más cortos.`, true);
      return;
    }
    setStatus('Corriendo backtest…');
    const result = backtest(dates, closes, shortP, longP);
    lastResult = { dates, closes, shortP, longP, symbol, ...result };
    renderAll(lastResult);
    setStatus(`Listo — ${closes.length} días de datos de ${symbol}, del ${dates[0]} al ${dates[dates.length - 1]}.`);
  } catch (err) {
    console.error(err);
    setStatus('Error al descargar datos (posible límite de la API pública). Intenta de nuevo en unos segundos.', true);
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

loadAssetOptions().finally(runBacktestFlow);
