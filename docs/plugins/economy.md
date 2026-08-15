# Economy plugin

**Beta.** Economy still ships breaking changes: stored balances, catalogs, and market data can be reset or migrated, and commands or settings may be renamed between releases. Run it on a test server before a live community. The dashboard flags this with a "Beta" badge and a warning on open.

Guild-scoped virtual economy: currencies, banks, rewards, shops, inventory, jobs, pets, crafting, quests, direct trades, marketplace, and auctions. **Gambling and real-money conversion are not supported.**

Economy is **off by default**. Enable it under the new **Economy** category on the dashboard (or set `plugins.economy.enabled: true` in guild YAML).

## Commands

Everything lives under **`/economy`**:

| Group | Subcommands |
|---|---|
| `account` | balance, bank, deposit, withdraw, history, profile, privacy |
| `rewards` | daily, weekly, monthly, streak, work, status |
| `social` | pay, gift, inspect |
| `shop` | browse, item, buy, sell, use, equip, unequip, inventory |
| `jobs` | list, choose, work, resign, progress |
| `pets` | list, adopt, info, active, feed, play, train, adventure, battle, rename, release |
| `craft` | recipes, make, queue, collect, cancel |
| `quests` | list, progress, claim, achievements |
| `market` | browse, list, buy, cancel, my-listings |
| `trade` | start, add, remove, review, confirm, cancel |
| `auction` | browse, create, bid, buyout, cancel, watch |
| `leaderboard` | richest, balance, networth, xp, pets, season |
| `season` | info, rewards, progress |
| `admin` | adjust, freeze, unfreeze, inspect, wipe, pause, resume, restock, settle, seed |

## Architecture

- **YAML config** — module toggles, currency display names, fees, reward amounts, anti-farm rules, privacy, permissions (`can_*`).
- **SQLite** — balances, append-only ledger, catalogs (items/shops/jobs/pets/recipes/quests), inventory, trades, markets, auctions, seasons.
- All money mutations go through an **atomic ledger** with integer amounts, escrow (`frozen`), and optional idempotency keys.

Balances never cross servers.

## Dashboard

The Economy setup editor is split into six tabs:

1. **Start** — a four-step readiness checklist with fix-it buttons, manual seed/restock/settle runs, the emergency pause, money-supply and 14-day mint/sink analytics, and the feature toggles.
2. **Money** — currency names and symbols, starting balances, bank fees and interest, booster/role multipliers, and the audit and announcement channels.
3. **Earning** — daily/weekly/monthly claims, work payouts, chat and voice earning with its anti-farm limits, and economy XP.
4. **Catalog** — create and edit shops, shop stock, items, jobs, pet species, recipes, quests, achievements, and seasons.
5. **Trading** — payment tax and limits, inventory caps, marketplace and auction rules, and leaderboard privacy.
6. **Members** — look up an account, adjust balances, freeze or unfreeze, and read the recent ledger.

Settings tabs save with the rest of the dashboard; catalog and member changes apply the moment they are saved.

## Permissions

Member defaults (`>=0`) can use the consumer commands. Staff (`>=50`) get admin adjust/freeze/inspect/catalog/market tools. Wipe requires `>=100`.

## Logging

Events: `economy_adjust`, `economy_transfer`, `economy_shop`, `economy_trade`, `economy_auction`, `economy_freeze`, `economy_season`, plus `dashboard_economy`.

## Dreamcode

- `economy_balance` — read pocket/bank/frozen
- `economy_add` / `economy_take` — staff-gated mutations (ledger-backed)
- `economy_has_item` — inventory check

## Anti-abuse

- Cooldowns on work/jobs/activity
- Optional message/voice mint caps and channel/role denylists
- Account freeze + emergency pause
- Escrow for trades and auctions (no double-spend)

## Seeding

First use of `/economy` seeds starter currencies (coins/gems), a general shop, default quests, jobs, and pet species. Staff can re-run seed via `/economy admin seed` or the dashboard.
