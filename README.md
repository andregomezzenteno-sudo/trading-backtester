# Trading Strategy Backtester

A small, real, publicly-runnable backtester for a moving-average-crossover trading
strategy, built on real historical market data across crypto, stocks, indices, and
commodities. No backend, no build step — open `index.html` and it runs.

**[Live demo →](https://andregomezzenteno-sudo.github.io/trading-backtester/)**

## What it does

1. Pick an asset type (crypto, stocks, indices, commodities) and an asset:
   - **Crypto** — the top ~150 coins by market cap, loaded live from CoinGecko.
   - **Stocks** — a curated list of ~25 well-known large caps.
   - **Indices / commodities** — served via well-known ETF proxies (e.g. S&P 500
     via `SPY`, gold via `GLD`), labeled as such — direct index/futures symbols
     require a paid data-provider plan, so this is the honest free-tier option,
     not a hidden substitution.
   Then a historical range (up to the free-tier max — 365 calendar days for crypto,
   365 trading days for everything else).
2. Set the short and long SMA periods for a classic **moving-average crossover**
   strategy: go long when the short SMA crosses above the long SMA, exit when it
   crosses back below.
3. The app fetches daily closing prices, runs the backtest client-side, and shows:
   - Price chart with both SMAs and buy/sell signal markers
   - Equity curve: the strategy vs. simply buying and holding the asset
   - Metrics: total return, max drawdown, annualized Sharpe ratio, win rate, trade count
4. **Manual "what-if" simulator:** click two points on the price chart to mark your
   own entry and exit, pick long or short, and optionally add leverage. It computes
   P&L on margin the way a real leveraged position would — including **liquidation**:
   if price moves against you by `1/leverage` before your exit, the position is
   force-closed there instead of quietly riding out an impossible drawdown.
5. **Evergreen / private-equity structure comparator:** takes the same real asset
   and shows what it would look like wrapped in a PE-style evergreen fund instead —
   lock-up, quarterly liquidity windows, an illiquidity premium, and appraisal-based
   reporting that only partially catches up to the true value each quarter. The
   point: reported volatility and drawdown come out much lower than the *real*
   underlying risk — not because the structure is safer, but because of how it's
   priced. Pick a hypothetical exit date and it tells you how long you'd actually
   have to wait past lock-up + the next liquidity window.

## Methodology notes (the part that actually matters)

- **No lookahead bias.** A crossover is only detectable once a full day's close is
  known, so a signal computed from day *i*'s data is executed at day *i+1*'s close —
  never the same bar that produced it. See `backtest()` in [app.js](app.js).
- **Sharpe ratio, and every other annualized figure, uses the right trading
  calendar for the asset:** `√365` for crypto (trades every calendar day) vs.
  `√252` for stocks/indices/commodities (business days only) — including inside
  the evergreen comparator, where a "quarter" and a "month" are derived from that
  same bars-per-year figure rather than hardcoded as calendar days. See
  `barsPerYear` threaded through `computeMetrics()` and `computeEvergreenSeries()`
  in [app.js](app.js).
- **Data limitation, stated up front:** both free-tier APIs cap how much history
  they'll return (CoinGecko: 365 calendar days for crypto; Twelve Data: rate- and
  plan-gated for stocks/indices/commodities). The UI says so — the tool doesn't
  pretend to have more history than it does.
- **This is a research/education tool, not investment advice** and doesn't execute
  real trades. Most simple crossover strategies underperform buy-and-hold most of
  the time — that's an expected, honest result, not a bug.
- **Leverage liquidation is isolated-margin, simplified.** `liquidationPrice =
  entryPrice * (1 ± 1/leverage)`, ignoring maintenance-margin buffers and fees —
  close enough to be honest about the risk without modeling a specific exchange's
  exact margin rules. See `simulateManualTrade()` in [app.js](app.js).
- **The evergreen comparator is an illustrative model, explicitly, not real fund
  data** — no free (or even cheap) source of real PE fund NAVs/returns exists,
  which is itself the point being illustrated. The appraisal-smoothing mechanic
  (`reported = θ·true + (1-θ)·previousReported`, θ=0.35) follows the standard
  academic "return smoothing" model for appraisal-based asset classes (Geltner for
  real estate; Getmansky, Lo & Makarov for hedge funds/PE) rather than a naive
  moving average — a plain trailing average of i.i.d. daily noise barely changes
  *annualized* volatility (square-root-of-time scaling cancels it out), so it
  wouldn't actually demonstrate the effect. See `computeEvergreenSeries()` in
  [app.js](app.js).

## Architecture

Almost everything runs in the browser:

- `index.html` / `style.css` — layout and design system (light/dark aware)
- `engine.js` — the pure calculation core: SMA/crossover backtest, metrics
  (Sharpe, max drawdown, win rate), the leveraged manual-trade simulator with
  isolated-margin liquidation, and the evergreen/private-equity comparator.
  Touches no DOM, so the test suite imports it directly and runs the exact
  code that ships — not a copy that can drift out of sync.
- `config.js` — deployment configuration (the data-proxy URL); no secrets.
- `app.js` — data fetching, DOM wiring, and hand-rolled SVG chart rendering
  (no charting library dependency).
- Market data: [CoinGecko public API](https://www.coingecko.com/en/api) for
  crypto (no key needed, called directly from the client) and
  [Twelve Data](https://twelvedata.com/) for stocks/indices/commodities,
  proxied through a small Cloudflare Worker (see below).

This means the whole thing deploys as static files (GitHub Pages, Vercel,
Cloudflare Pages, ...) plus one small serverless function — no server to run
continuously, no infrastructure to pay for.

### Keeping the API key server-side

Earlier versions of this project embedded the Twelve Data key directly in
`app.js`, reasoning that a free-tier, rate-limited key carries no real risk
even if public. That's true as far as it goes, but a credential sitting in a
public repository's source is a bad signal regardless of its actual blast
radius — and whoever spots it may never read the justification.

The sibling project, [PathFolio](https://github.com/andregomezzenteno-sudo/pathfolio),
established the fix: a small Cloudflare Worker (`worker/`) holds the key as a
server-side secret and proxies requests on the app's behalf, enforcing:

- a symbol allowlist (only the 35 tickers this app actually offers),
- an origin allowlist (only this site and localhost),
- a request-size cap, and
- a 6-hour edge cache (cuts real usage against an 8-req/min free-tier quota).

CoinGecko isn't proxied — it's a public, keyless API, so routing it through
the Worker would add a network hop for no security benefit.

To run your own instance: get a free key at twelvedata.com, deploy the Worker
(see [worker/README.md](worker/README.md)), and point `dataProxyUrl` in
[`config.js`](config.js) at it.

## Tests

```bash
npm test
```

Runs `tests/engine.test.mjs` against `engine.js` directly — no DOM, no
mocking, the same functions the browser calls. Covers the SMA/crossover
timing (a signal detected on day *i* is only ever acted on at day *i+1*'s
close), the leveraged-trade liquidation threshold and earliest-touch
detection, the evergreen comparator's appraisal-smoothing math, and the
lock-up/liquidity-window exit calculation — including the edge cases (zero
leverage, zero variance, no trades, exits beyond the available data).

## Running locally

No build step. Any static file server works, e.g.:

```bash
npx serve .
# or
python -m http.server 8000
```

Then open the printed local URL.

## Deployment

Deployed via GitHub Pages, serving directly from `main` — any push to `main`
updates the live demo. To fork and deploy your own copy: push to your fork, then
enable **Settings → Pages → Deploy from branch → main → / (root)**.

## Possible extensions

- Additional strategies (RSI, MACD, mean reversion) behind the same backtest engine
- Position sizing / transaction costs / slippage modeling
- Parameter sweep to visualize how returns vary across SMA period combinations
