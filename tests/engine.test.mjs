/* Estas pruebas importan engine.js DIRECTAMENTE: ejecutan el mismo código
   que corre en el navegador, no una copia — mismo motivo que en el proyecto
   hermano (PathFolio). Solo es posible porque engine.js no toca el DOM. */
import engine from '../engine.js';

const {
  sma, backtest, computeMetrics, maxDrawdown, annualizedVol,
  simulateManualTrade, computeEvergreenSeries, computeExitAvailability,
} = engine;

function assert(cond, msg) { if (!cond) throw new Error('FALLO: ' + msg); }
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// Fechas sintéticas: un día calendario por barra, no importa el valor exacto
// para estas pruebas, solo que sean crecientes y distintas.
function syntheticDates(n) {
  const out = [];
  const d = new Date(Date.UTC(2024, 0, 1));
  for (let i = 0; i < n; i++) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

function main() {

  /* ---------- sma() ---------- */
  {
    const out = sma([1, 2, 3, 4, 5], 3);
    assert(out[0] === null && out[1] === null, 'los primeros period-1 valores deben ser null');
    assert(close(out[2], 2) && close(out[3], 3) && close(out[4], 4),
      `la media móvil de 3 sobre [1..5] debería dar [null,null,2,3,4], dio ${JSON.stringify(out)}`);
    const empty = sma([1, 2], 5);
    assert(empty.every(v => v === null), 'un periodo mayor que la serie entera no debería dar ningún valor');
    console.log('OK: sma() calcula la media móvil y respeta el arranque en null');
  }

  /* ---------- backtest(): la decisión del día i se ejecuta en i+1, nunca en el mismo día ---------- */
  {
    // Serie diseñada para un cruce alcista claro alrededor del día 5: sube
    // fuerte primero, para que las medias corta y larga terminen cruzadas.
    const closes = [10, 10, 10, 10, 10, 12, 14, 16, 18, 20, 20, 20, 20, 20, 20];
    const dates = syntheticDates(closes.length);
    const r = backtest(dates, closes, 2, 4);
    assert(r.trades.length >= 1, 'debería haberse abierto al menos una operación con ese cruce');
    const t = r.trades[0];
    // La media corta (2) supera a la larga (4) en algún día D; la entrada real
    // tiene que quedar en D+1 o después — NUNCA en el mismo día del cruce.
    const a = r.smaShort, b = r.smaLong;
    let crossDay = -1;
    for (let i = 1; i < closes.length; i++) {
      if (a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null) {
        if (a[i - 1] - b[i - 1] <= 0 && a[i] - b[i] > 0) { crossDay = i; break; }
      }
    }
    assert(crossDay >= 0, 'la serie de prueba debería producir un cruce detectable');
    assert(t.entryIndex > crossDay, `la entrada (día ${t.entryIndex}) debería ser POSTERIOR al día del cruce (día ${crossDay}), nunca el mismo día`);
    assert(t.entryIndex === crossDay + 1, `con la señal ejecutándose al día siguiente, la entrada debería ser exactamente crossDay+1=${crossDay + 1}, fue ${t.entryIndex}`);

    // buy&hold tiene que replicar el precio crudo exactamente, sin estrategia de por medio.
    const n = closes.length;
    const rawRatio = closes[n - 1] / closes[0];
    assert(close(r.buyHoldEquity[n - 1], rawRatio),
      `buy&hold debería terminar en ${rawRatio}, terminó en ${r.buyHoldEquity[n - 1]}`);
    console.log('OK: backtest() solo actúa un día DESPUÉS del cruce, nunca en el mismo, y buy&hold replica el precio crudo');
  }

  /* ---------- backtest(): posición abierta al final de los datos se cierra marcada como tal ---------- */
  {
    const closes = [10, 10, 10, 10, 10, 12, 14, 16, 18, 20];
    const dates = syntheticDates(closes.length);
    const r = backtest(dates, closes, 2, 4);
    if (r.trades.length) {
      const last = r.trades[r.trades.length - 1];
      if (last.exitIndex === closes.length - 1) {
        assert(last.openAtEnd === true, 'una operación que sigue abierta al final de los datos debe marcarse openAtEnd');
      }
    }
    console.log('OK: una posición que sigue abierta al terminar los datos se marca openAtEnd');
  }

  /* ---------- computeMetrics() / maxDrawdown() / annualizedVol() ---------- */
  {
    const equity = [1, 1.2, 0.9, 1.1];
    const dd = maxDrawdown(equity);
    assert(close(dd, (0.9 - 1.2) / 1.2), `drawdown de [1,1.2,0.9,1.1] debería ser ${(0.9 - 1.2) / 1.2}, dio ${dd}`);

    const flatRets = [0.001, 0.001, 0.001, 0.001];
    const vol = annualizedVol(flatRets, 252);
    assert(close(vol, 0), `retornos constantes deberían dar volatilidad 0 (sin varianza), dio ${vol}`);

    const flatResult = {
      closes: [1, 1, 1, 1], strategyEquity: [1, 1, 1, 1], buyHoldEquity: [1, 1, 1, 1],
      dailyReturns: [0, 0, 0], trades: [],
    };
    const m = computeMetrics(flatResult, 252);
    assert(m.sharpe === 0, `con desviación típica 0, el sharpe debe quedar en 0 (no NaN ni Infinity), dio ${m.sharpe}`);
    assert(m.winRate === null, `sin ninguna operación, winRate debe ser null (no 0, que insinuaría que hubo operaciones perdedoras), dio ${m.winRate}`);
    console.log('OK: computeMetrics()/maxDrawdown()/annualizedVol() no rompen en los casos límite (sin varianza, sin operaciones)');
  }

  /* ---------- simulateManualTrade(): apalancamiento y liquidación ---------- */
  {
    const closes = [100, 95, 90, 85, 80, 85, 90, 95, 100, 105];
    const dates = syntheticDates(closes.length);

    // Sin apalancamiento (1x): nunca debe liquidar, por mucho que caiga el precio.
    const noLev = simulateManualTrade({ dates, closes, entryIndex: 0, exitIndex: closes.length - 1, direction: 'long', leverage: 1, sizeUsd: 1000 });
    assert(!noLev.liquidated, 'a 1x (sin apalancar) nunca debería liquidar');

    // Largo a 10x: el precio de liquidación debe ser EXACTAMENTE entryPrice*(1-1/10).
    const long10 = simulateManualTrade({ dates, closes, entryIndex: 0, exitIndex: closes.length - 1, direction: 'long', leverage: 10, sizeUsd: 1000 });
    assert(close(long10.liquidationPrice, 100 * 0.9), `liquidación de un largo a 10x debería ser ${100 * 0.9}, fue ${long10.liquidationPrice}`);
    assert(long10.liquidated, 'con el precio cayendo a 80 (un -20%), un largo a 10x (liquida al -10%) debería haberse liquidado');
    assert(long10.pnlPct === -1, `una posición liquidada debe perder exactamente el 100% del margen, dio ${long10.pnlPct}`);

    // Corto a 10x: el precio de liquidación debe ser entryPrice*(1+1/10). Con
    // este camino de precios (mínimo 80, nunca sube de 100 antes del suelo)
    // un corto no debería liquidar.
    const short10 = simulateManualTrade({ dates, closes, entryIndex: 0, exitIndex: 4, direction: 'short', leverage: 10, sizeUsd: 1000 });
    assert(close(short10.liquidationPrice, 100 * 1.1), `liquidación de un corto a 10x debería ser ${100 * 1.1}, fue ${short10.liquidationPrice}`);
    assert(!short10.liquidated, 'un corto no debería liquidar en un tramo donde el precio solo baja');
    assert(short10.pnlPct > 0, 'un corto con el precio bajando de 100 a 80 debería dar beneficio');

    // La liquidación debe detectarse en el PRIMER día que toca el umbral, no
    // en uno posterior aunque el precio se recupere después.
    const dipCloses = [100, 100, 89, 100, 100]; // toca el umbral de 10x (90) en el día 2 y se recupera
    const dipDates = syntheticDates(dipCloses.length);
    const dip = simulateManualTrade({ dates: dipDates, closes: dipCloses, entryIndex: 0, exitIndex: 4, direction: 'long', leverage: 10, sizeUsd: 1000 });
    assert(dip.liquidated && dip.exitIndex === 2, `debería liquidar en el día 2 (el primer toque), no seguir hasta el final; salió en el día ${dip.exitIndex}`);

    // Identidad algebraica: sin liquidar, el PnL en USD sobre margen tiene que
    // coincidir con calcularlo sobre el nocional — son la misma cifra por dos caminos.
    const notLiq = simulateManualTrade({ dates, closes, entryIndex: 4, exitIndex: 9, direction: 'long', leverage: 4, sizeUsd: 2000 });
    const priceChangePct = (closes[9] - closes[4]) / closes[4];
    const pnlPorNocional = 2000 * priceChangePct;
    assert(close(notLiq.pnlUsd, pnlPorNocional),
      `el PnL en USD (${notLiq.pnlUsd}) debería coincidir con nocional×variación de precio (${pnlPorNocional})`);

    console.log('OK: simulateManualTrade() liquida al umbral exacto, en el primer toque, y el PnL cuadra por las dos vías de cálculo');
  }

  /* ---------- computeEvergreenSeries(): smoothing de tasaciones ---------- */
  {
    // Necesita cubrir varias marcas trimestrales de verdad: con barsPerYear=252,
    // quarterBars=63, así que un array de 40 ni siquiera llega a la primera.
    const n = 300;
    const flatCloses = new Array(n).fill(100); // mercado plano: sin retorno de mercado, solo prima + lastre de rampa
    const barsPerYear = 252;

    // Con theta=1 (ajuste instantáneo, sin suavizado real) el valor reportado
    // debe COINCIDIR EXACTAMENTE con el verdadero en cada marca trimestral.
    const full = computeEvergreenSeries({ closes: flatCloses, premiumAnnual: 0, barsPerYear, smoothingTheta: 1 });
    const q = full.quarterBars;
    assert(close(full.reportedEquity[q], full.trueEquity[q]),
      `con theta=1 lo reportado debe igualar lo real en la primera marca trimestral: reportado=${full.reportedEquity[q]}, real=${full.trueEquity[q]}`);

    // Con theta=0 (ningún ajuste) lo reportado debe quedarse congelado en su
    // valor inicial para siempre, por mucho que el valor real se mueva.
    const frozen = computeEvergreenSeries({ closes: flatCloses, premiumAnnual: 0.08, barsPerYear, smoothingTheta: 0 });
    assert(close(frozen.reportedEquity[n - 1], frozen.reportedEquity[0]),
      `con theta=0 lo reportado no debería moverse nunca: arrancó en ${frozen.reportedEquity[0]}, terminó en ${frozen.reportedEquity[n - 1]}`);

    // Entre dos marcas trimestrales, lo reportado debe quedarse plano (no se
    // actualiza día a día, es justo el punto del modelo).
    const mid = computeEvergreenSeries({ closes: flatCloses, premiumAnnual: 0.08, barsPerYear, smoothingTheta: 0.35 });
    assert(close(mid.reportedEquity[1], mid.reportedEquity[q - 1]),
      'lo reportado no debería cambiar entre dos marcas trimestrales consecutivas');

    console.log('OK: computeEvergreenSeries() reproduce el ajuste parcial (theta) y mantiene el valor plano entre marcas');
  }

  /* ---------- computeExitAvailability(): lock-up + ventana trimestral ---------- */
  {
    const n = 400;
    const dates = syntheticDates(n);
    const barsPerYear = 252;
    const quarterBars = Math.round(barsPerYear / 4);

    // Lock-up corto: la fecha pedida manda, redondeada a la siguiente ventana.
    const r1 = computeExitAvailability({ dates, requestedDate: dates[50], lockupMonths: 1, barsPerYear, quarterBars });
    assert(r1.exitIndex >= 50 && r1.exitIndex % quarterBars === 0,
      `con lock-up corto, la salida (${r1.exitIndex}) debería caer en una marca trimestral posterior a la fecha pedida (día 50)`);

    // Lock-up largo: el propio lock-up manda, aunque se pida salir antes.
    const r2 = computeExitAvailability({ dates, requestedDate: dates[10], lockupMonths: 12, barsPerYear, quarterBars });
    const monthBars = barsPerYear / 12;
    const lockupEndExpected = Math.round(12 * monthBars);
    assert(r2.exitIndex >= lockupEndExpected,
      `con lock-up largo (termina en el día ${lockupEndExpected}), la salida no puede ser antes aunque se pidiera en el día 10; salió en ${r2.exitIndex}`);

    // Fecha pedida más allá de los datos disponibles: se acota al final.
    const r3 = computeExitAvailability({ dates, requestedDate: '2099-01-01', lockupMonths: 1, barsPerYear, quarterBars });
    assert(r3.requestedIndex === n - 1, 'una fecha pedida fuera de rango debe acotarse al último día disponible');
    assert(r3.clampedByData === true, 'si la salida calculada cae fuera de los datos, debe señalarse clampedByData');

    console.log('OK: computeExitAvailability() respeta lock-up + ventana trimestral y se acota cuando faltan datos');
  }

  console.log('\nTODAS LAS PRUEBAS DEL MOTOR DEL BACKTESTER PASAN');
}

main();
