'use strict';
/*
 * Configuración del despliegue. Se carga antes que el resto y no contiene
 * secretos: solo dice DÓNDE están las cosas.
 *
 * dataProxyUrl — URL del Cloudflare Worker que hace de proxy hacia Twelve
 * Data para acciones, índices y materias primas (ver worker/README.md).
 * Cuando está puesta, el navegador nunca ve la clave de la API: se la pone
 * el Worker desde un secreto de Cloudflare. Es obligatoria: sin ella la app
 * falla diciendo qué falta, en vez de volver a incrustar una credencial en
 * el cliente.
 *
 * CoinGecko (cripto) no aparece aquí: es pública y sin clave, así que el
 * navegador la sigue llamando directamente.
 */
window.BACKTESTER_CONFIG = {
  dataProxyUrl: 'https://trading-backtester-data-proxy.allpainends.workers.dev',
};
