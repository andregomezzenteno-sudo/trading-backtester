# Market-data proxy

Small Cloudflare Worker sitting between the app and Twelve Data so **the API
key never has to travel to the browser**.

Without it, a static site calling a keyed API has nowhere to hide that key —
it ends up embedded in the shipped JavaScript, and therefore visible in the
repository. With the proxy, the key lives as a Cloudflare secret and the
browser only ever talks to this Worker.

It's not a blind forward, because an open proxy would be worse than the
exposed key: anyone could burn the quota. It enforces a symbol allowlist, an
origin allowlist, a request-size cap, and a 6-hour cache (daily bars don't
change within the day, so this also saves a lot of quota on an 8-req/min
free-tier plan).

## Deploy it

```bash
npm install -g wrangler          # if you don't have it
cd worker
wrangler login                   # opens the browser once
wrangler secret put TWELVE_DATA_API_KEY   # paste the key when prompted
wrangler deploy
```

`wrangler deploy` prints the URL, something like
`https://trading-backtester-data-proxy.YOUR-SUBDOMAIN.workers.dev`.

Paste it into [`../config.js`](../config.js):

```js
window.BACKTESTER_CONFIG = { dataProxyUrl: 'https://trading-backtester-data-proxy.YOUR-SUBDOMAIN.workers.dev' };
```

From then on the app stops using any embedded key. If you're forking this
project and it previously had a key committed to a public repo, **rotate it**
on the Twelve Data dashboard — a key that's been in git history has to be
treated as compromised, deleting it from the current file doesn't remove it
from history.

## Check it

```bash
curl "https://YOUR-WORKER.workers.dev?symbol=AAPL&outputsize=5"    # 200 with data
curl "https://YOUR-WORKER.workers.dev?symbol=ZZZZ&outputsize=5"    # 400, not on the list
```
