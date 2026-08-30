# Economy plugin

Two independent currencies:

- **Global coins** — bot-wide, fixed name, denominator, and emoji (`Coins`, `$`, <:coin:1543696697685844048>),
  earned everywhere the bot is installed. Sending a message earns **0.15** coins (60s cooldown per member);
  balances carry across every server.
- **Server currency** — per-guild, name/denominator/emoji/rates fully customisable by that server's managers.
  Earned the same way (messages, plus `/daily`), scoped to that one server.

`/balance` and `/daily` both require picking `global` or `server`. Economy is **off by default** — enable it under
**Economy** on the dashboard, or set `plugins.economy.enabled: true` in guild YAML.

## Commands

| Command | Description |
|---|---|
| `/balance <global\|server> [user]` | View a balance |
| `/daily <global\|server>` | Claim that currency's daily reward |
| `/economy view` | View this server's currency settings (managers) |
| `/economy settings` | Change this server's currency name, denominator, emoji, multiplier, message reward, message cooldown, and daily amount (managers) |
| `/stock` | Links to the Dreamliner Exchange on the site |

## Architecture

- **YAML config** (`plugins.economy.config.server`) — currency name/denominator/emoji, message reward amount and
  cooldown, multiplier, daily amount, and enable toggle. Permissions (`can_*`).
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

## Permissions

Member defaults (`>=0`) can use `/economy balance` and `/economy daily`. Managers (`>=50`) get `/economy admin`.

## Logging

Events: `economy_admin_change`, plus `dashboard_economy`.
