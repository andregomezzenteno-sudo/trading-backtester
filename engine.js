'use strict';
/*
 * engine.js — el motor determinista del backtester: media móvil, backtest de
 * cruce, simulación manual apalancada (con liquidación) y el comparador de
 * estructura evergreen/private equity.
 *
 * Vive separado de app.js a propósito y no toca el DOM ni una sola vez, mismo
 * motivo que en el proyecto hermano (PathFolio): las pruebas importan ESTE
 * fichero y ejecutan el código que corre en producción, no una copia que
 * pueda desincronizarse.
 *
 * Sin empaquetadores ni paso de compilación: en el navegador se carga con un
 * <script> normal y publica sus funciones como globales; en Node se importa
 * con require/import. El mismo fichero, sin transpilar.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

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

// Manual "what-if" trade: long or short, optionally leveraged, on the same
// historical closes already loaded for the backtest. Leverage is modeled with
// isolated-margin liquidation — a leveraged position that gets wiped out stops
// there rather than silently riding out an impossible drawdown, since a
// simulator that ignores liquidation would just be lying by omission.
function simulateManualTrade({ dates, closes, entryIndex, exitIndex, direction, leverage, sizeUsd }) {
  const entryPrice = closes[entryIndex];
  const liqFraction = 1 / leverage;
  const liquidationPrice = direction === 'long'
    ? entryPrice * (1 - liqFraction)
    : entryPrice * (1 + liqFraction);

  const scanEnd = exitIndex != null ? exitIndex : closes.length - 1;
  let liquidated = false;
  let stopIndex = scanEnd;
  for (let i = entryIndex; i <= scanEnd; i++) {
    const price = closes[i];
    const hit = direction === 'long' ? price <= liquidationPrice : price >= liquidationPrice;
    if (hit) { liquidated = true; stopIndex = i; break; }
  }

  const exitPrice = liquidated ? liquidationPrice : closes[stopIndex];
  const priceChangePct = direction === 'long'
    ? (exitPrice - entryPrice) / entryPrice
    : (entryPrice - exitPrice) / entryPrice;
  const pnlPct = liquidated ? -1 : priceChangePct * leverage;
  const margin = sizeUsd / leverage;
  const pnlUsd = margin * pnlPct;

  return {
    entryIndex, entryDate: dates[entryIndex], entryPrice,
    exitIndex: stopIndex, exitDate: dates[stopIndex], exitPrice,
    liquidated, liquidationPrice, direction, leverage,
    margin, notional: sizeUsd, pnlPct, pnlUsd,
    daysHeld: stopIndex - entryIndex,
  };
}

function computeMetrics(r, barsPerYear) {
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
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(barsPerYear) : 0;

  const wins = r.trades.filter(t => t.returnPct > 0).length;
  const winRate = r.trades.length ? wins / r.trades.length : null;

  return { strategyReturn, buyHoldReturn, maxDD, sharpe, winRate, tradeCount: r.trades.length };
}

function maxDrawdown(equitySeries) {
  let peak = equitySeries[0], maxDD = 0;
  for (const v of equitySeries) {
    peak = Math.max(peak, v);
    maxDD = Math.min(maxDD, (v - peak) / peak);
  }
  return maxDD;
}

function annualizedVol(rets, periodsPerYear) {
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear);
}

// Applies textbook evergreen/PE-structure mechanics on top of the SAME real
// closes already loaded — this is an illustrative model, not real fund data
// (no free source for that exists, which is the whole point being illustrated):
//  - illiquidity premium: a constant annualized return boost for locking up capital
//  - J-curve: an early fee drag during a ~6-month "deployment ramp"
//  - appraisal smoothing: NAV is only marked once per quarter, and each mark only
//    partially catches up to the true value (reported = theta*true + (1-theta)*prevReported).
//    This partial-adjustment ("return smoothing") model is the standard academic
//    explanation for why appraisal-based asset classes look less volatile than they
//    are — see Geltner (real estate) and Getmansky/Lo/Makarov (hedge funds/PE) —
//    and produces a much stronger, more realistic damping than naive infrequent
//    sampling alone: temporally aggregating i.i.d. daily returns into quarterly
//    ones barely changes ANNUALIZED volatility (square-root-of-time scaling), but
//    a genuinely lagging appraisal does.
// quarterBars/monthBars are derived from barsPerYear (365 for crypto, which
// trades every calendar day; 252 for stocks/indices/commodities, which only
// trade on business days) so "one quarter" and "one month" line up with real
// calendar time regardless of the underlying asset's trading calendar.
function computeEvergreenSeries({ closes, premiumAnnual, barsPerYear, smoothingTheta = 0.35 }) {
  const n = closes.length;
  const quarterBars = Math.max(1, Math.round(barsPerYear / 4));
  const dailyRet = new Array(n).fill(0);
  for (let i = 1; i < n; i++) dailyRet[i] = (closes[i] - closes[i - 1]) / closes[i - 1];

  const premiumPerBar = Math.pow(1 + premiumAnnual, 1 / barsPerYear) - 1;
  const rampBars = Math.min(Math.round(barsPerYear / 2), Math.floor(n / 4));
  const dragPerBar = 0.02 / barsPerYear; // illustrative ~2%/yr fee drag during deployment

  const trueEquity = new Array(n).fill(1);
  for (let i = 1; i < n; i++) {
    let ret = dailyRet[i] + premiumPerBar;
    if (i <= rampBars) ret -= dragPerBar;
    trueEquity[i] = trueEquity[i - 1] * (1 + ret);
  }

  const reportedEquity = new Array(n).fill(trueEquity[0]);
  let lastReported = trueEquity[0];
  const marks = [0];
  for (let i = 1; i < n; i++) {
    if (i % quarterBars === 0 || i === n - 1) {
      lastReported = smoothingTheta * trueEquity[i] + (1 - smoothingTheta) * lastReported;
      marks.push(i);
    }
    reportedEquity[i] = lastReported;
  }

  const quarterlyReturns = [];
  for (let k = 1; k < marks.length; k++) {
    quarterlyReturns.push((reportedEquity[marks[k]] - reportedEquity[marks[k - 1]]) / reportedEquity[marks[k - 1]]);
  }

  return { trueEquity, reportedEquity, quarterlyReturns, quarterBars };
}

// Given a requested exit date, works out the earliest date the investor could
// actually withdraw: max(lock-up end, requested date), rounded up to the next
// quarterly liquidity window.
function computeExitAvailability({ dates, requestedDate, lockupMonths, barsPerYear, quarterBars }) {
  const n = dates.length;
  let requestedIndex = dates.findIndex(d => d >= requestedDate);
  if (requestedIndex === -1) requestedIndex = n - 1;

  const monthBars = barsPerYear / 12;
  const lockupEndIndex = Math.min(n - 1, Math.round(lockupMonths * monthBars));
  const earliestPossible = Math.max(requestedIndex, lockupEndIndex);

  let exitIndex = Math.ceil(earliestPossible / quarterBars) * quarterBars;
  const clampedByData = exitIndex > n - 1;
  if (clampedByData) exitIndex = n - 1;

  return { requestedIndex, lockupEndIndex, exitIndex, clampedByData };
}

  return {
    sma, backtest, computeMetrics, maxDrawdown, annualizedVol,
    simulateManualTrade, computeEvergreenSeries, computeExitAvailability,
  };
});
