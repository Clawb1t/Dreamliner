import type { Client } from "discord.js";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import {
  economyStockActivityMinutes,
  economyStockHoldings,
  economyStockPriceHistory,
  economyStocks,
  economyStockTransactions,
} from "../../../db/schema.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { ensureGlobalAccount, creditGlobal, spendGlobal, round2, InsufficientFundsError } from "./money.js";
import { SERVER_DAILY_BASE_AMOUNT } from "./format.js";

export class StockError extends Error {
  constructor(
    message: string,
    public code: "not_found" | "invalid" | "insufficient" = "invalid",
  ) {
    super(message);
    this.name = "StockError";
  }
}

const MIN_PRICE = 0.5;
const MAX_PRICE = 100_000;
const STARTING_PRICE = 10;
const SHARE_PRECISION = 10_000; // 4 decimal places

function now() {
  return new Date();
}

function roundShares(shares: number): number {
  return Math.round(shares * SHARE_PRECISION) / SHARE_PRECISION;
}

/** Short uppercase ticker derived from the guild's name, unique within the exchange. */
function generateSymbol(guildName: string, taken: Set<string>): string {
  const letters = guildName.toUpperCase().replace(/[^A-Z0-9]/g, "");
  let base = letters.slice(0, 4) || "SRV";
  if (base.length < 2) base = (base + "XXXX").slice(0, 4);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base.slice(0, 4 - String(n).length)}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}${Date.now() % 1000}`;
}

export function getStock(guildId: string) {
  return getDb().select().from(economyStocks).where(eq(economyStocks.guildId, guildId)).get() ?? null;
}

export function getStockBySymbol(symbol: string) {
  return (
    getDb()
      .select()
      .from(economyStocks)
      .where(eq(economyStocks.symbol, symbol.trim().toUpperCase()))
      .get() ?? null
  );
}

/** Ticker/server-name search for autocomplete, ranked by price. */
export function searchStocks(query: string, limit = 25) {
  const db = getDb();
  const rows = db.select().from(economyStocks).orderBy(desc(economyStocks.price)).all();
  const q = query.trim().toLowerCase();
  const filtered = q ? rows.filter((r) => r.symbol.toLowerCase().includes(q) || r.guildName.toLowerCase().includes(q)) : rows;
  return filtered.slice(0, limit);
}

/** Create the listing for a guild the first time it's seen (idempotent). */
export function ensureStock(guildId: string, guildName: string, guildIcon: string | null) {
  const db = getDb();
  const existing = getStock(guildId);
  if (existing) return existing;

  const taken = new Set(db.select({ symbol: economyStocks.symbol }).from(economyStocks).all().map((r) => r.symbol));
  const symbol = generateSymbol(guildName, taken);
  const timestamp = now();
  db.insert(economyStocks)
    .values({
      guildId,
      symbol,
      guildName,
      guildIcon,
      price: STARTING_PRICE,
      activityScore: 1,
      listedAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  db.insert(economyStockPriceHistory).values({ guildId, price: STARTING_PRICE, recordedAt: timestamp }).run();
  return getStock(guildId)!;
}

// ── Live activity → price ────────────────────────────────────────────────────
// Prices are checked minute by minute, not on a slow timer, and every check
// is persisted (not just in-memory) so a bot restart never loses progress or
// silently stalls a stock. Every tracked message bumps a per-guild,
// per-minute counter in the database. Once a minute, every listed stock with
// activity that minute has its message count compared against the *average
// count across every other listed stock for that same minute* — a server
// posting faster than the rest of the exchange right now climbs quickly.
//
// Grace: a minute with zero messages never moves the price at all — no drift,
// no noise, for the first stretch of quiet. A server going quiet for a short
// while just holds where it was, it doesn't get punished for a lull; gains
// from an earlier active stretch stick around instead of bleeding away the
// moment the channel goes quiet. Only once a stock has gone truly cold — no
// messages for a while — does it start slowly drifting down, the way a
// real illiquid stock does when nobody's trading it. It picks right back up
// the instant the server posts again.
//
// Mean reversion: every price move is also weighed against the stock's own
// trailing average over the last few hours. The further a price has run up
// above that average, the harder it gets pulled back toward it — a quiet
// spike settles on its own, and a stock that's climbed a long way comes back
// down noticeably faster than one that's only drifted up a little. This
// applies whether the stock is actively climbing or just sitting quiet, so
// an overextended price doesn't get to coast forever during a lull either.

const MINUTE_MS = 60_000;
/** How far an especially active minute can push the price up (ratio 3 = 3x the exchange average). */
const UP_DRIFT_SCALE = 0.012;
/** Much gentler pull for a minute that's active but slower than the exchange — never a crash. */
const DOWN_DRIFT_SCALE = 0.008;
const ACTIVE_NOISE = 0.004;
/** How long a stock can sit with zero activity before it starts declining. */
const INACTIVITY_GRACE_MS = 20 * MINUTE_MS;
/** Gentle per-minute decay once a stock is past the grace period — a stock
 *  left completely cold loses about half its value over roughly a day. */
const INACTIVITY_DECAY_RATE = 0.0005;
/** Old activity buckets are pruned past this so the table doesn't grow forever. */
const ACTIVITY_RETENTION_MS = 6 * 60 * 60_000;
/** Trailing window used as a stock's own "home" price for mean reversion. */
const REVERSION_LOOKBACK_MS = 4 * 60 * MINUTE_MS;
/** How hard an active tick pulls an overextended price back toward its trailing average. */
const REVERSION_SCALE = 0.05;
/** Gentler version of the same pull applied during a quiet tick, so overextension bleeds off even without new activity. */
const REVERSION_SCALE_PASSIVE = 0.015;
/** >1 makes the pull grow faster than the overextension itself — the higher a price has run, the quicker it comes back. */
const REVERSION_EXPONENT = 1.4;

function minuteBucket(d: Date): string {
  return d.toISOString().slice(0, 16); // "2026-08-29T23:17"
}

/** Call once per tracked message. Lists the guild the first time it's seen. */
export function recordStockActivity(guildId: string, guildName: string, guildIcon: string | null): void {
  ensureStock(guildId, guildName, guildIcon);
  const bucket = minuteBucket(now());
  getDb()
    .insert(economyStockActivityMinutes)
    .values({ guildId, minuteBucket: bucket, messages: 1 })
    .onConflictDoUpdate({
      target: [economyStockActivityMinutes.guildId, economyStockActivityMinutes.minuteBucket],
      set: { messages: sql`${economyStockActivityMinutes.messages} + 1` },
    })
    .run();
}

/** A stock's own trailing average price over `REVERSION_LOOKBACK_MS`, used as its mean-reversion anchor. */
function trailingAveragePrice(guildId: string, since: Date, fallbackPrice: number): number {
  const rows = getDb()
    .select({ price: economyStockPriceHistory.price })
    .from(economyStockPriceHistory)
    .where(and(eq(economyStockPriceHistory.guildId, guildId), gte(economyStockPriceHistory.recordedAt, since)))
    .all();
  if (rows.length === 0) return fallbackPrice;
  return rows.reduce((sum, r) => sum + r.price, 0) / rows.length;
}

/** Downward pull (as a fraction of price) for how far above its own trailing average a price has run. Grows faster than the overextension itself. */
function reversionPull(price: number, anchor: number, scale: number): number {
  if (anchor <= 0 || price <= anchor) return 0;
  const overExtension = price / anchor - 1;
  return scale * overExtension ** REVERSION_EXPONENT;
}

function messagesInBucket(guildId: string, bucket: string): number {
  const row = getDb()
    .select({ messages: economyStockActivityMinutes.messages })
    .from(economyStockActivityMinutes)
    .where(and(eq(economyStockActivityMinutes.guildId, guildId), eq(economyStockActivityMinutes.minuteBucket, bucket)))
    .get();
  return row?.messages ?? 0;
}

/**
 * Runs once a minute from the economy plugin's onLoad. Lists any newly
 * economy-enabled guild, moves each active stock's price based on the
 * message count of the minute that just finished versus the rest of the
 * exchange for that same minute, holds quiet stocks exactly where they are,
 * and always leaves a fresh price-history point so the chart stays
 * continuous either way.
 */
export async function tickStockPrices(client: Client): Promise<void> {
  const db = getDb();
  const tickTime = now();
  const bucket = minuteBucket(new Date(tickTime.getTime() - MINUTE_MS));

  const listed: { guildId: string; messages: number }[] = [];
  for (const guild of client.guilds.cache.values()) {
    try {
      const guildConfig = await configManager.getEffectiveConfig(guild.id);
      if (!pluginEnabled(guildConfig, "economy")) continue;

      ensureStock(guild.id, guild.name, guild.iconURL({ size: 64 }));
      db.update(economyStocks)
        .set({ guildName: guild.name, guildIcon: guild.iconURL({ size: 64 }) })
        .where(eq(economyStocks.guildId, guild.id))
        .run();

      listed.push({ guildId: guild.id, messages: messagesInBucket(guild.id, bucket) });
    } catch (err) {
      console.error(`Stock listing refresh failed for guild ${guild.id}:`, err);
    }
  }

  const totalMessages = listed.reduce((sum, g) => sum + g.messages, 0);

  for (const { guildId, messages } of listed) {
    try {
      const stock = getStock(guildId);
      if (!stock) continue;

      const reversionAnchor = trailingAveragePrice(guildId, new Date(tickTime.getTime() - REVERSION_LOOKBACK_MS), stock.price);

      // No activity this minute. Within the grace period, hold the price where it is aside
      // from a gentle passive pull back toward its own trailing average — a mildly elevated
      // price just holds flat, but a badly overextended one keeps easing down even through a
      // quiet lull instead of coasting at the peak. `updatedAt` is deliberately left untouched
      // here (it's only ever bumped by an active tick below), so it keeps marking the last real
      // activity — once it's more than the grace period behind, the stock has gone cold and
      // starts a slow decay instead.
      if (messages === 0) {
        const inactiveMs = tickTime.getTime() - stock.updatedAt.getTime();
        if (inactiveMs <= INACTIVITY_GRACE_MS) {
          const passivePull = reversionPull(stock.price, reversionAnchor, REVERSION_SCALE_PASSIVE);
          const heldPrice = passivePull > 0 ? round2(Math.max(MIN_PRICE, stock.price * (1 - passivePull))) : stock.price;
          if (heldPrice !== stock.price) {
            db.update(economyStocks).set({ price: heldPrice }).where(eq(economyStocks.guildId, guildId)).run();
          }
          db.insert(economyStockPriceHistory).values({ guildId, price: heldPrice, recordedAt: tickTime }).run();
          continue;
        }

        const decayedPrice = round2(Math.max(MIN_PRICE, stock.price * (1 - INACTIVITY_DECAY_RATE)));
        db.update(economyStocks).set({ price: decayedPrice }).where(eq(economyStocks.guildId, guildId)).run();
        db.insert(economyStockPriceHistory).values({ guildId, price: decayedPrice, recordedAt: tickTime }).run();
        continue;
      }

      const others = listed.length > 1 ? (totalMessages - messages) / (listed.length - 1) : 0;
      const ratio = others > 0 ? Math.min(messages / others, 3) : 1.5;
      const scale = ratio >= 1 ? UP_DRIFT_SCALE : DOWN_DRIFT_SCALE;
      const drift = (ratio - 1) * scale;
      const noise = (Math.random() - 0.5) * ACTIVE_NOISE;
      const pull = reversionPull(stock.price, reversionAnchor, REVERSION_SCALE);

      const nextPrice = round2(Math.max(MIN_PRICE, Math.min(MAX_PRICE, stock.price * (1 + drift + noise - pull))));
      db.update(economyStocks)
        .set({ price: nextPrice, activityScore: round2(ratio), updatedAt: tickTime })
        .where(eq(economyStocks.guildId, guildId))
        .run();
      db.insert(economyStockPriceHistory).values({ guildId, price: nextPrice, recordedAt: tickTime }).run();
    } catch (err) {
      console.error(`Stock price tick failed for guild ${guildId}:`, err);
    }
  }

  db.delete(economyStockActivityMinutes)
    .where(lt(economyStockActivityMinutes.minuteBucket, minuteBucket(new Date(tickTime.getTime() - ACTIVITY_RETENTION_MS))))
    .run();
}

export type StockRow = ReturnType<typeof getStock> extends infer T ? NonNullable<T> : never;

// ── Currency exchange ────────────────────────────────────────────────────────
// Server currency converts to global coins at a rate tied to that server's own
// stock: trading at its $10 starting price exchanges 1:1, a stock that's run up
// pays out a bonus, and a stock that's cratered pays out a reduced rate — "low
// stock means a low exchange rate". Clamped well short of the stock's own price
// bounds so a single runaway or cratered price can't make the exchange useless.

const EXCHANGE_MIN_RATE = 0.1;
const EXCHANGE_MAX_RATE = 3;

/** Pure so it's easy to test: rate scales linearly with price relative to `basePrice`, clamped to sane bounds. */
export function computeExchangeRate(price: number, basePrice = STARTING_PRICE): number {
  return round2(Math.min(EXCHANGE_MAX_RATE, Math.max(EXCHANGE_MIN_RATE, price / basePrice)));
}

/** Server currency → global coin exchange rate for a guild, based on its current stock price (unlisted guilds get the base 1x rate). */
export function getExchangeRate(guildId: string): number {
  const stock = getStock(guildId);
  return computeExchangeRate(stock?.price ?? STARTING_PRICE);
}

/** This server's current `/daily` server-currency payout: the fixed base amount scaled by the
 *  same stock-price curve as the exchange rate — a booming server pays its members a better
 *  daily too, a cratered one pays less, same `0.1x`–`3x` bounds as `/exchange`. */
export function getServerDailyAmount(guildId: string): number {
  return round2(SERVER_DAILY_BASE_AMOUNT * getExchangeRate(guildId));
}

function changeSince(guildId: string, price: number, since: Date): { changeAmount: number; changePct: number } {
  const db = getDb();
  const openRow = db
    .select({ price: economyStockPriceHistory.price })
    .from(economyStockPriceHistory)
    .where(and(eq(economyStockPriceHistory.guildId, guildId), gte(economyStockPriceHistory.recordedAt, since)))
    .orderBy(economyStockPriceHistory.recordedAt)
    .limit(1)
    .get();
  const openPrice = openRow?.price ?? price;
  const changeAmount = round2(price - openPrice);
  const changePct = openPrice > 0 ? round2((changeAmount / openPrice) * 100) : 0;
  return { changeAmount, changePct };
}

export function getStockWithChange(guildId: string) {
  const stock = getStock(guildId);
  if (!stock) return null;
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return { ...stock, ...changeSince(guildId, stock.price, since24h) };
}

export function listStocks(opts: { limit?: number } = {}) {
  const db = getDb();
  const rows = db.select().from(economyStocks).orderBy(desc(economyStocks.price)).all();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const limited = opts.limit ? rows.slice(0, opts.limit) : rows;
  return limited.map((stock) => ({
    ...stock,
    ...changeSince(stock.guildId, stock.price, since24h),
  }));
}

export type StockRange = "24h" | "7d" | "30d";

function rangeSince(range: StockRange): Date {
  const ms = range === "7d" ? 7 : range === "30d" ? 30 : 1;
  return new Date(Date.now() - ms * 24 * 60 * 60 * 1000);
}

export function getStockHistory(guildId: string, range: StockRange = "24h") {
  const db = getDb();
  const since = rangeSince(range);
  return db
    .select({ price: economyStockPriceHistory.price, recordedAt: economyStockPriceHistory.recordedAt })
    .from(economyStockPriceHistory)
    .where(and(eq(economyStockPriceHistory.guildId, guildId), gte(economyStockPriceHistory.recordedAt, since)))
    .orderBy(economyStockPriceHistory.recordedAt)
    .all();
}

/** One merged time series across several stocks, for the exchange overview chart. */
export function getExchangeSeries(guildIds: string[], range: StockRange = "24h") {
  if (guildIds.length === 0) return [];
  const db = getDb();
  const since = rangeSince(range);
  const rows = db
    .select({
      guildId: economyStockPriceHistory.guildId,
      price: economyStockPriceHistory.price,
      recordedAt: economyStockPriceHistory.recordedAt,
    })
    .from(economyStockPriceHistory)
    .where(and(inArray(economyStockPriceHistory.guildId, guildIds), gte(economyStockPriceHistory.recordedAt, since)))
    .orderBy(economyStockPriceHistory.recordedAt)
    .all();

  const byTime = new Map<number, Record<string, number>>();
  for (const row of rows) {
    const key = row.recordedAt.getTime();
    const point = byTime.get(key) ?? {};
    point[row.guildId] = row.price;
    byTime.set(key, point);
  }
  return [...byTime.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, point]) => ({ recordedAt: new Date(t).toISOString(), ...point }));
}

// ── Candles & RSI ─────────────────────────────────────────────────────────────
// Mirrors the website's own chartMath.ts (buildCandles / RSI) so the chart image
// attached to /stock view and the RSI reading in its embed line up with what
// members see on the exchange site — the two are separate codebases with no
// shared package between them, so the math is intentionally kept this simple
// and duplicated rather than reached for across repos.

export type StockCandle = {
  open: number;
  high: number;
  low: number;
  close: number;
  startTime: string;
  endTime: string;
};

/** Buckets a price-history series into up to `target` OHLC candles. */
export function buildStockCandles(history: { price: number; recordedAt: Date }[], target = 40): StockCandle[] {
  if (history.length === 0) return [];
  const bucketSize = Math.max(1, Math.ceil(history.length / target));
  const candles: StockCandle[] = [];
  for (let i = 0; i < history.length; i += bucketSize) {
    const chunk = history.slice(i, i + bucketSize);
    const prices = chunk.map((p) => p.price);
    candles.push({
      open: prices[0]!,
      close: prices[prices.length - 1]!,
      high: Math.max(...prices),
      low: Math.min(...prices),
      startTime: chunk[0]!.recordedAt.toISOString(),
      endTime: chunk[chunk.length - 1]!.recordedAt.toISOString(),
    });
  }
  return candles;
}

/**
 * Wilder's RSI (the standard 14-period formula) over a series of closing prices, 0-100: above 70
 * reads as overbought (run up fast, due for a pullback), below 30 as oversold (dropped fast, due
 * for a bounce). Returns null when there isn't yet enough history to seed a full period.
 */
export function computeRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change >= 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return round2(100 - 100 / (1 + rs));
}

export type RSIReading = "overbought" | "oversold" | "neutral";

/** Standard 70/30 overbought/oversold thresholds. */
export function classifyRSI(rsi: number): RSIReading {
  if (rsi >= 70) return "overbought";
  if (rsi <= 30) return "oversold";
  return "neutral";
}

// ── Trade market impact ──────────────────────────────────────────────────────
// Buying and selling actually moves the price now, the way a real (if simplified)
// order book would: a buy pushes the price up, a sell pushes it down, sized
// against the stock's own price as a stand-in for market depth — a $100 trade
// barely nudges a stock already at $5,000, but meaningfully moves one still at
// $2, the same way a bigger market cap absorbs the same trade more easily.
// Impact grows with the square root of trade size rather than linearly (real
// order-book impact isn't linear either), so splitting a big order into several
// smaller ones costs about the same as one large one, while MAX_TRADE_IMPACT
// keeps any single trade — however huge — from spiking or crashing the price
// outright. The moved price is persisted immediately as a fresh history point
// (same as a minute activity tick), so the chart and RSI reflect a trade right
// away instead of waiting for the next tick; the same mean-reversion pull in
// tickStockPrices applies to it afterward regardless of what caused the move.

/** A trade worth this many multiples of the stock's own price counts as one full "depth unit" — pricier stocks read as deeper, harder-to-move markets. */
const LIQUIDITY_DEPTH_MULT = 500;
/** Price-move fraction from a trade exactly one depth unit in size. */
const TRADE_IMPACT_SCALE = 0.06;
/** Hard per-trade cap so a single huge order can't spike or crash the price outright. */
const MAX_TRADE_IMPACT = 0.15;

/** Fractional price move (always positive; callers apply the direction) for a trade worth `coinsValue` against a stock currently at `price`. */
export function computeTradeImpact(price: number, coinsValue: number): number {
  if (!(price > 0) || !(coinsValue > 0)) return 0;
  const depth = price * LIQUIDITY_DEPTH_MULT;
  const raw = TRADE_IMPACT_SCALE * Math.sqrt(coinsValue / depth);
  return Math.min(MAX_TRADE_IMPACT, raw);
}

// ── Holdings & trading ───────────────────────────────────────────────────────

export function getHolding(userId: string, guildId: string) {
  return (
    getDb()
      .select()
      .from(economyStockHoldings)
      .where(and(eq(economyStockHoldings.userId, userId), eq(economyStockHoldings.guildId, guildId)))
      .get() ?? null
  );
}

export function getPortfolio(userId: string) {
  const db = getDb();
  const holdings = db.select().from(economyStockHoldings).where(eq(economyStockHoldings.userId, userId)).all();
  const balance = ensureGlobalAccount(userId).balance;
  const positions = holdings
    .map((holding) => {
      const stock = getStock(holding.guildId);
      if (!stock) return null;
      const marketValue = round2(holding.shares * stock.price);
      const pl = round2(marketValue - holding.costBasis);
      const plPct = holding.costBasis > 0 ? round2((pl / holding.costBasis) * 100) : 0;
      return { ...holding, stock, marketValue, pl, plPct };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
  const totalValue = round2(positions.reduce((sum, p) => sum + p.marketValue, 0));
  return { balance, positions, totalValue };
}

export function listTransactions(userId: string, limit = 25) {
  return getDb()
    .select()
    .from(economyStockTransactions)
    .where(eq(economyStockTransactions.userId, userId))
    .orderBy(desc(economyStockTransactions.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100))
    .all();
}

export function buyStock(userId: string, guildId: string, coins: number) {
  if (!(coins > 0)) throw new StockError("Amount must be positive.", "invalid");
  const stock = getStock(guildId);
  if (!stock) throw new StockError("That server isn't listed on the exchange.", "not_found");

  const shares = roundShares(coins / stock.price);
  if (shares <= 0) throw new StockError("That's too little to buy any shares.", "invalid");

  const db = getDb();
  try {
    return db.transaction((tx) => {
      spendGlobal(userId, coins);
      const existing = getHolding(userId, guildId);
      const timestamp = now();
      if (existing) {
        tx.update(economyStockHoldings)
          .set({
            shares: roundShares(existing.shares + shares),
            costBasis: round2(existing.costBasis + coins),
            updatedAt: timestamp,
          })
          .where(and(eq(economyStockHoldings.userId, userId), eq(economyStockHoldings.guildId, guildId)))
          .run();
      } else {
        tx.insert(economyStockHoldings)
          .values({ userId, guildId, shares, costBasis: coins, updatedAt: timestamp })
          .run();
      }
      tx.insert(economyStockTransactions)
        .values({ userId, guildId, type: "buy", shares, price: stock.price, amount: coins, createdAt: timestamp })
        .run();

      // Buying pushes the price up — see the "Trade market impact" section above.
      let marketPrice = stock.price;
      const impact = computeTradeImpact(stock.price, coins);
      if (impact > 0) {
        marketPrice = round2(Math.max(MIN_PRICE, Math.min(MAX_PRICE, stock.price * (1 + impact))));
        if (marketPrice !== stock.price) {
          tx.update(economyStocks).set({ price: marketPrice, updatedAt: timestamp }).where(eq(economyStocks.guildId, guildId)).run();
          tx.insert(economyStockPriceHistory).values({ guildId, price: marketPrice, recordedAt: timestamp }).run();
        }
      }

      return { shares, price: stock.price, marketPrice, balance: ensureGlobalAccount(userId).balance };
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) throw new StockError(err.message, "insufficient");
    throw err;
  }
}

export function sellStock(userId: string, guildId: string, shares: number) {
  if (!(shares > 0)) throw new StockError("Amount must be positive.", "invalid");
  const stock = getStock(guildId);
  if (!stock) throw new StockError("That server isn't listed on the exchange.", "not_found");
  const holding = getHolding(userId, guildId);
  if (!holding || holding.shares < shares - 0.0001) {
    throw new StockError("You don't own that many shares.", "insufficient");
  }

  const proceeds = round2(shares * stock.price);
  const db = getDb();
  return db.transaction((tx) => {
    const remainingShares = roundShares(holding.shares - shares);
    const timestamp = now();
    if (remainingShares <= 0.0001) {
      tx.delete(economyStockHoldings)
        .where(and(eq(economyStockHoldings.userId, userId), eq(economyStockHoldings.guildId, guildId)))
        .run();
    } else {
      const remainingCostBasis = round2(holding.costBasis * (remainingShares / holding.shares));
      tx.update(economyStockHoldings)
        .set({ shares: remainingShares, costBasis: remainingCostBasis, updatedAt: timestamp })
        .where(and(eq(economyStockHoldings.userId, userId), eq(economyStockHoldings.guildId, guildId)))
        .run();
    }
    tx.insert(economyStockTransactions)
      .values({ userId, guildId, type: "sell", shares, price: stock.price, amount: proceeds, createdAt: timestamp })
      .run();
    creditGlobal(userId, proceeds);

    // Selling pushes the price down — mirrors the buy-side impact in buyStock above.
    let marketPrice = stock.price;
    const impact = computeTradeImpact(stock.price, proceeds);
    if (impact > 0) {
      marketPrice = round2(Math.max(MIN_PRICE, Math.min(MAX_PRICE, stock.price * (1 - impact))));
      if (marketPrice !== stock.price) {
        tx.update(economyStocks).set({ price: marketPrice, updatedAt: timestamp }).where(eq(economyStocks.guildId, guildId)).run();
        tx.insert(economyStockPriceHistory).values({ guildId, price: marketPrice, recordedAt: timestamp }).run();
      }
    }

    return { shares, price: stock.price, marketPrice, proceeds, balance: ensureGlobalAccount(userId).balance };
  });
}
