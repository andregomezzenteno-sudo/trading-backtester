/**
 * trading-backtester — proxy de datos de mercado (Cloudflare Worker)
 *
 * Mismo motivo y mismo patrón que el proyecto hermano, PathFolio: sin este
 * Worker delante, la clave de la API de Twelve Data tiene que ir incrustada
 * en el JavaScript del navegador, y por tanto queda a la vista en un
 * repositorio público. La versión anterior de este proyecto la llevaba así,
 * razonando que al ser de plan gratuito y sin riesgo de facturación no
 * importaba — pero una credencial en el código fuente sigue siendo una mala
 * señal en cualquier proyecto que se mire con criterio fintech, y quien la
 * vea puede no llegar nunca a leer la justificación.
 *
 * Con este Worker delante, la clave vive como secreto de Cloudflare
 * (`wrangler secret put`), nunca se sirve al cliente y no aparece en el
 * repositorio. El navegador solo habla con este proxy.
 *
 * No es un reenvío ciego. Un proxy abierto sería peor que la clave expuesta,
 * porque cualquiera podría usarlo para consultar lo que quisiera a costa de
 * esta cuota. De ahí las cuatro restricciones de abajo.
 *
 * CoinGecko (los precios de cripto) NO pasa por aquí: es una API pública sin
 * clave, así que el navegador la sigue llamando directamente — proxear algo
 * que no tiene secreto que guardar solo añadiría un salto de red sin ganar
 * nada.
 */

// 1) Lista blanca de símbolos: exactamente los 35 que ASSET_CATALOG ofrece en
//    app.js (25 acciones + 4 índices vía ETF + 6 materias primas vía ETF).
//    Cualquier otra cosa se rechaza.
const ALLOWED_SYMBOLS = new Set([
  // acciones
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'JPM', 'V', 'WMT',
  'JNJ', 'PG', 'XOM', 'KO', 'DIS', 'NFLX', 'AMD', 'INTC', 'BA', 'NKE',
  'PFE', 'CSCO', 'ORCL', 'ADBE', 'CRM',
  // índices vía ETF
  'SPY', 'QQQ', 'DIA', 'IWM',
  // materias primas vía ETF
  'GLD', 'SLV', 'USO', 'UNG', 'DBA', 'DBC',
]);

// 2) Orígenes permitidos. Sin esto, cualquier web podría llamar al proxy
//    desde el navegador de sus visitantes y gastar la cuota.
const ALLOWED_ORIGINS = [
  'https://andregomezzenteno-sudo.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

// 3) Tope de tamaño: la app pide hasta 365 barras diarias; nada justifica más.
const MAX_OUTPUTSIZE = 500;

// 4) Caché. Las barras diarias no cambian dentro del día, así que guardar la
//    respuesta durante horas reduce muchísimo el consumo de un plan que va
//    justo (8 peticiones por minuto) y hace la app bastante más rápida.
const CACHE_SECONDS = 6 * 60 * 60;

const UPSTREAM = 'https://api.twelvedata.com/time_series';

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(body, status, origin, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin), ...(extra || {}) },
  });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') {
      return json({ status: 'error', message: 'Solo se admite GET.' }, 405, origin);
    }
    if (!env.TWELVE_DATA_API_KEY) {
      // Fallo de configuración, no del cliente: mejor decirlo claramente que
      // devolver un error de la API de arriba que despiste.
      return json({ status: 'error', message: 'El proxy no tiene configurada la clave (wrangler secret put TWELVE_DATA_API_KEY).' }, 500, origin);
    }

    const url = new URL(request.url);
    const symbol = url.searchParams.get('symbol');
    const outputsize = parseInt(url.searchParams.get('outputsize') || '365', 10);

    if (!symbol || !ALLOWED_SYMBOLS.has(symbol)) {
      return json({ status: 'error', message: `Símbolo no permitido: ${symbol || '(vacío)'}.` }, 400, origin);
    }
    if (!Number.isFinite(outputsize) || outputsize < 1 || outputsize > MAX_OUTPUTSIZE) {
      return json({ status: 'error', message: `outputsize debe estar entre 1 y ${MAX_OUTPUTSIZE}.` }, 400, origin);
    }

    // La clave de caché omite el origen a propósito: la respuesta de mercado
    // es idéntica para todos, así que una sola entrada sirve a todo el mundo.
    const cacheKey = new Request(`https://cache.trading-backtester/${encodeURIComponent(symbol)}/${outputsize}`);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const body = await cached.text();
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT', ...corsHeaders(origin) },
      });
    }

    const upstream = new URL(UPSTREAM);
    upstream.searchParams.set('symbol', symbol);
    upstream.searchParams.set('interval', '1day');
    upstream.searchParams.set('outputsize', String(outputsize));
    upstream.searchParams.set('apikey', env.TWELVE_DATA_API_KEY);

    let res;
    try {
      res = await fetch(upstream.toString());
    } catch (err) {
      return json({ status: 'error', message: 'No se pudo contactar con el proveedor de datos.' }, 502, origin);
    }

    const text = await res.text();

    // Solo se cachean las respuestas buenas: cachear un 429 dejaría la app
    // rota durante horas justo por haber tenido mala suerte una vez.
    let ok = res.ok;
    try { ok = ok && JSON.parse(text).status !== 'error'; } catch (e) { ok = false; }
    if (ok) {
      ctx.waitUntil(cache.put(cacheKey, new Response(text, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_SECONDS}` },
      })));
    }

    return new Response(text, {
      status: res.status,
      headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS', ...corsHeaders(origin) },
    });
  },
};
