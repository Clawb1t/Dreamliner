# Economy plugin

Two independent currencies:

- **Global coins** — bot-wide, fixed name, denominator, and emoji (`Coins`, `$`, <:coin:1543696697685844048>),
  earned everywhere the bot is installed. Sending a message earns **0.15** coins (60s cooldown per member);
  balances carry across every server.
- **Server currency** — per-guild, name/denominator/emoji customisable by that server's managers, scoped to that
  one server. Earn *rates* are **not** manager-configurable (see below) — messages pay a fixed **0.1** (5s
  cooldown), and `/daily` scales automatically with that server's own Dreamliner Exchange stock price. This is
  deliberate: since `/exchange` converts server currency into global coins, a manager-tunable rate would let a
  server mint unlimited global coins for free.

`/balance` and `/daily` both require picking `global` or `server`. Economy is **off by default** — enable it under
**Economy** on the dashboard, or set `plugins.economy.enabled: true` in guild YAML.

## Commands

| Command | Description |
|---|---|
| `/balance <global\|server> [user]` | View a balance |
| `/daily <global\|server>` | Claim that currency's daily reward |
| `/economy view` | View this server's currency settings, including the current market-rate daily amount (managers) |
| `/economy settings` | Change this server's currency name, denominator, emoji, and whether message rewards are on (managers) |
| `/exchange <amount>` | Convert server currency into global coins, at a rate set by this server's own stock price |
| `/stock` | Links to the Dreamliner Exchange on the site |

## Architecture

- **YAML config** (`plugins.economy.config.server`) — currency name/denominator/emoji, the message-rewards on/off
  toggle, and enable toggle. Permissions (`can_*`). Earn rates (message amount/cooldown, daily amount) are fixed
  bot-wide constants in `functions/format.ts` (`SERVER_MESSAGE_AMOUNT`, `SERVER_MESSAGE_COOLDOWN_SECONDS`,
  `SERVER_DAILY_BASE_AMOUNT`), not part of guild config — there is no admin override for them, on the dashboard or
  otherwise. Admins also cannot adjust a member's server-currency balance directly (the dashboard's bridge endpoint
  for balance adjustment is global-coins-only); server currency only moves through normal play and `/exchange`.
- **SQLite** — `economy_global_accounts` (one row per user, bot-wide) and `economy_server_accounts` (one row per
  guild+user). Both store a decimal `balance`, last message/daily claim timestamps, and a daily streak counter.

Global balances never cross into server balances and vice versa.

## Dreamliner Exchange (server stocks)

Every server with the economy plugin enabled is auto-listed as a "stock" on the site (`/stocks`). Members invest
their **global coins** to buy shares (`src/plugins/economy/functions/stocks.ts`); trading itself only happens on
the website, through the dashboard bridge (`src/bridge/webStocks.ts`).

Prices are checked **once a minute**, not on a slow timer: every `MessageCreate` in an economy-enabled guild calls
`recordStockActivity`, which bumps a persisted per-guild, per-minute message counter (`economy_stock_activity_minutes`
— a real table, not in-memory, so a bot restart never loses progress or silently stalls a stock). Once a minute,
`tickStockPrices` compares every listed stock's message count for the minute that just finished against the
*average count across every other listed stock for that same minute* — a server posting faster than the rest of
the exchange right now climbs quickly (up to +3.5%/min at 4x the average); one posting slower still moves, just
gently (down to -1%/min at most).

**Grace**: a minute with zero messages never moves the price at all — no drift, no noise, just a flat heartbeat
history point so the chart keeps drawing. A server going quiet overnight holds exactly where it was instead of
bleeding gains away; a stock only ever loses ground while it's still posting, just slower than everyone else.
Investing is meant to be "put coins in, check back a day later", not "watch it every minute or lose it all".

- **SQLite** — `economy_stocks` (one row per guild — symbol, price, activity score), `economy_stock_price_history`
  (every minute's price point, for the charts), `economy_stock_activity_minutes` (persisted per-minute message
  counts, pruned after 6 hours), `economy_stock_holdings` (shares + cost basis per user per guild), and
  `economy_stock_transactions` (a buy/sell ledger).

## Currency exchange

`/exchange <amount>` converts a member's **server currency** balance into **global coins**, at a rate tied to that
server's own stock price (`computeExchangeRate` in `src/plugins/economy/functions/stocks.ts`): trading at the $10
starting price exchanges 1:1, a stock that's run up pays out a bonus, and a stock that's cratered pays out less —
low stock means a low exchange rate. The rate is clamped to `0.1x`–`3x` so neither a runaway nor a cratered price
makes the exchange useless. The debit/credit itself (`exchangeServerForGlobal` in `functions/money.ts`) is a single
atomic transaction — a member's server currency never disappears without the matching global coins landing.

The same `0.1x`–`3x` rate also scales the `/daily` server-currency payout (`getServerDailyAmount`, off a
`SERVER_DAILY_BASE_AMOUNT` of 5) — a booming server pays its members a better daily too, not just a better
exchange. Both are read-only market effects; there is no admin control over either.

## Permissions

Member defaults (`>=0`) can use `/economy balance`, `/economy daily`, and `/exchange`. Managers (`>=50`) get
`/economy admin`.

## Logging

Events: `economy_admin_change`, plus `dashboard_economy`.
