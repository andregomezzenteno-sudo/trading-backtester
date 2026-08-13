# Trading Strategy Backtester

A small, real, publicly-runnable backtester for a moving-average-crossover trading
strategy, built on real historical market data. No backend, no API keys, no build
step — open `index.html` and it runs.

**[Live demo →](https://andregomezzenteno-sudo.github.io/trading-backtester/)**

## What it does

1. Pick an asset — the top ~150 cryptocurrencies by market cap, loaded live from
   CoinGecko — and a historical range (up to the 365 days the free API allows).
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
- **Sharpe ratio** is annualized with `√365`, not the usual `√252`, since crypto
  markets trade every day of the year.
- **Data limitation, stated up front:** CoinGecko's free public API caps historical
  daily data at 365 days. The UI says so — the tool doesn't pretend to have more
  history than it does.
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
- Market data: [CoinGecko public API](https://www.coingecko.com/en/api), called
  directly from the client — CORS-enabled, no API key, no server to host or pay for

This means the whole thing deploys as static files (GitHub Pages, Vercel,
Cloudflare Pages, ...) with zero ongoing infrastructure cost, and each visitor's
own browser does the computation.

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
