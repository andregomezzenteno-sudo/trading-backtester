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

Everything runs in the browser:

- `index.html` / `style.css` — layout and design system (light/dark aware)
- `app.js` — data fetching, the backtest engine, and hand-rolled SVG chart
  rendering (no charting library dependency)
- Market data: [CoinGecko public API](https://www.coingecko.com/en/api) for
  crypto (no key needed) and [Twelve Data](https://twelvedata.com/) for
  stocks/indices/commodities, both called directly from the client (CORS-enabled).

This means the whole thing deploys as static files (GitHub Pages, Vercel,
Cloudflare Pages, ...) with no server to host or pay for — each visitor's own
browser does the computation and the data fetching.

**On the embedded Twelve Data key:** it's a free-tier key, intentionally public.
Client-side-only architecture means any API key used here is necessarily visible
in the shipped code — there's no backend to hide it behind. It's rate-limited
(8 req/min, 800/day) with no paid tier attached, so the worst case if it's ever
reused elsewhere or the quota is exhausted is that stock/index/commodity backtests
stop responding until the quota resets; crypto is unaffected since it doesn't use
this key at all. If you fork this, get your own free key at twelvedata.com and
swap `TWELVE_DATA_API_KEY` in [app.js](app.js).

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
