import { and, desc, eq, inArray, lte, or } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { planeCardTradeItems, planeCardTrades } from "../../../db/schema.js";
import { round2 } from "../functions/money.js";
import { MAX_PENDING_TRADES_PER_USER, MAX_TRADE_COINS, MAX_TRADE_ITEMS_PER_SIDE, TRADE_EXPIRY_MS } from "./constants.js";
import { assertOwnedFree, countUserCopies, ensureCopyCapacity, getCopy, lockCopy, moveCopy, requireCopy, unlockCopy } from "./copies.js";
import { hangarError } from "./errors.js";
import { getCoinBalance, inTx, transferCoins } from "./ledger.js";
import { refreshUserScore } from "./score.js";

export type TradeRow = typeof planeCardTrades.$inferSelect;
export type TradeItemRow = typeof planeCardTradeItems.$inferSelect;
export type TradeWithItems = TradeRow & { fromCopyIds: number[]; toCopyIds: number[] };

export type CreateTradeInput = {
  fromUserId: string;
  toUserId: string;
  /** Copies the sender gives. */
  giveCopyIds: number[];
  /** Copies the sender asks for from the recipient. */
  wantCopyIds: number[];
  giveCoins?: number;
  wantCoins?: number;
  note?: string | null;
  parentTradeId?: number | null;
  at?: Date;
};

function withItems(trade: TradeRow): TradeWithItems {
  const items = getDb().select().from(planeCardTradeItems).where(eq(planeCardTradeItems.tradeId, trade.id)).all();
  return {
    ...trade,
    fromCopyIds: items.filter((i) => i.side === "from").map((i) => i.copyId),
    toCopyIds: items.filter((i) => i.side === "to").map((i) => i.copyId),
  };
}

export function getTrade(id: number): TradeWithItems | null {
  const row = Number.isInteger(id) ? getDb().select().from(planeCardTrades).where(eq(planeCardTrades.id, id)).get() : undefined;
  return row ? withItems(row) : null;
}

export function listTrades(userId: string, opts: { status?: "pending" | "all"; limit?: number } = {}): TradeWithItems[] {
  const involved = or(eq(planeCardTrades.fromUserId, userId), eq(planeCardTrades.toUserId, userId));
  const rows = getDb()
    .select()
    .from(planeCardTrades)
    .where(opts.status === "pending" ? and(involved, eq(planeCardTrades.status, "pending")) : involved)
    .orderBy(desc(planeCardTrades.id))
    .limit(Math.min(100, opts.limit ?? 50))
    .all();
  return rows.map(withItems);
}

function coins(raw: number | undefined, label: string): number {
  const value = round2(Number(raw ?? 0));
  if (!Number.isFinite(value) || value < 0 || value > MAX_TRADE_COINS) throw hangarError("invalid", "{label} must be between 0 and {max}.", { label, max: MAX_TRADE_COINS });
  return value;
}

function uniqueIds(ids: number[], label: string): number[] {
  const out = [...new Set(ids.map(Number))];
  if (out.some((id) => !Number.isInteger(id) || id <= 0)) throw hangarError("invalid", "{label} must be copy ids.", { label });
  if (out.length > MAX_TRADE_ITEMS_PER_SIDE) throw hangarError("invalid", "At most {max} cards per side.", { max: MAX_TRADE_ITEMS_PER_SIDE });
  return out;
}

export function createTrade(input: CreateTradeInput): TradeWithItems {
  const at = input.at ?? new Date();
  if (input.fromUserId === input.toUserId) throw hangarError("invalid", "You can't trade with yourself.");
  const give = uniqueIds(input.giveCopyIds, "giveCopyIds");
  const want = uniqueIds(input.wantCopyIds, "wantCopyIds");
  const giveCoins = coins(input.giveCoins, "giveCoins");
  const wantCoins = coins(input.wantCoins, "wantCoins");
  if (give.length + want.length === 0 && giveCoins === 0 && wantCoins === 0) throw hangarError("invalid", "A trade needs at least one card or some coins.");
  if (give.length === 0 && want.length === 0) throw hangarError("invalid", "A trade needs at least one card.");
  if (giveCoins > 0 && wantCoins > 0) throw hangarError("invalid", "Only one side of a trade can add coins.");
  return inTx(() => {
    const pending = listTrades(input.fromUserId, { status: "pending", limit: 100 }).filter((t) => t.fromUserId === input.fromUserId);
    if (pending.length >= MAX_PENDING_TRADES_PER_USER) {
      throw hangarError("limit", "You already have {max} open trade offers.", { max: MAX_PENDING_TRADES_PER_USER });
    }
    for (const id of give) assertOwnedFree(requireCopy(id), input.fromUserId);
    for (const id of want) {
      const copy = requireCopy(id);
      if (copy.ownerId !== input.toUserId) throw hangarError("not_owner", "They don't own one of the cards you asked for.");
    }
    if (giveCoins > 0 && getCoinBalance(input.fromUserId) + 1e-9 < giveCoins) {
      throw hangarError("insufficient_coins", "You need {amount} coins for that.", { amount: giveCoins.toFixed(2) });
    }
    const trade = getDb()
      .insert(planeCardTrades)
      .values({
        fromUserId: input.fromUserId,
        toUserId: input.toUserId,
        fromCoins: giveCoins,
        toCoins: wantCoins,
        status: "pending",
        parentTradeId: input.parentTradeId ?? null,
        note: input.note ? String(input.note).slice(0, 200) : null,
        createdAt: at,
        expiresAt: new Date(at.getTime() + TRADE_EXPIRY_MS),
      })
      .returning()
      .get();
    for (const copyId of give) {
      getDb().insert(planeCardTradeItems).values({ tradeId: trade.id, copyId, side: "from" }).run();
      lockCopy(copyId, "trade", trade.id);
    }
    for (const copyId of want) getDb().insert(planeCardTradeItems).values({ tradeId: trade.id, copyId, side: "to" }).run();
    return withItems(trade);
  });
}

function requirePending(tradeId: number, at: Date): TradeWithItems {
  const trade = getTrade(tradeId);
  if (!trade) throw hangarError("not_found", "That trade doesn't exist.");
  if (trade.status !== "pending") throw hangarError("conflict", "That trade is already {status}.", { status: trade.status });
  if (trade.expiresAt <= at) throw hangarError("expired", "That trade has expired.");
  return trade;
}

/** Expires an overdue pending trade in its own transaction (so it sticks when the caller then fails). */
function expireIfOverdue(tradeId: number, at: Date): void {
  const trade = getTrade(tradeId);
  if (trade && trade.status === "pending" && trade.expiresAt <= at) inTx(() => closeTrade(trade, "expired", at));
}

function closeTrade(trade: TradeWithItems, status: "declined" | "cancelled" | "countered" | "expired" | "failed", at: Date): void {
  getDb()
    .update(planeCardTrades)
    .set({ status, resolvedAt: at })
    .where(and(eq(planeCardTrades.id, trade.id), eq(planeCardTrades.status, "pending")))
    .run();
  for (const copyId of trade.fromCopyIds) unlockCopy(copyId, "trade", trade.id);
}

/** Closes every pending trade the user is part of (account erasure). Call inside a transaction. */
export function cancelTradesForUser(userId: string, at = new Date()): number {
  const rows = getDb()
    .select()
    .from(planeCardTrades)
    .where(and(eq(planeCardTrades.status, "pending"), or(eq(planeCardTrades.fromUserId, userId), eq(planeCardTrades.toUserId, userId))))
    .all();
  for (const row of rows) closeTrade(withItems(row), "cancelled", at);
  return rows.length;
}

/**
 * Accepts a pending trade, atomically: every copy is re-checked (the sender's are still theirs and
 * held by this trade, the recipient's are still theirs and free), coins are re-checked, both
 * hangars have room, then copies and coins move together. Any failure rolls everything back.
 */
export function acceptTrade(tradeId: number, actorId: string, at = new Date()): TradeWithItems {
  expireIfOverdue(tradeId, at);
  return inTx(() => {
    const trade = requirePending(tradeId, at);
    if (trade.toUserId !== actorId) throw hangarError("forbidden", "Only the person the trade was sent to can accept it.");
    const fromCopies = trade.fromCopyIds.map((id) => {
      const copy = getCopy(id);
      if (!copy) throw hangarError("conflict", "A card in this trade no longer exists.");
      assertOwnedFree(copy, trade.fromUserId, { reason: "trade", ref: trade.id });
      return copy;
    });
    const toCopies = trade.toCopyIds.map((id) => {
      const copy = getCopy(id);
      if (!copy) throw hangarError("conflict", "A card in this trade no longer exists.");
      if (copy.ownerId !== trade.toUserId) throw hangarError("conflict", "A card in this trade changed hands.");
      assertOwnedFree(copy, trade.toUserId);
      return copy;
    });
    ensureCopyCapacity(trade.fromUserId, countUserCopies(trade.fromUserId) - fromCopies.length + toCopies.length);
    ensureCopyCapacity(trade.toUserId, countUserCopies(trade.toUserId) - toCopies.length + fromCopies.length);
    for (const copy of fromCopies) moveCopy(copy, trade.toUserId, "trade", { tradeId: trade.id });
    for (const copy of toCopies) moveCopy(copy, trade.fromUserId, "trade", { tradeId: trade.id });
    if (trade.fromCoins > 0) transferCoins(trade.fromUserId, trade.toUserId, trade.fromCoins, { out: "trade_out", in: "trade_in" }, `trade:${trade.id}`);
    if (trade.toCoins > 0) transferCoins(trade.toUserId, trade.fromUserId, trade.toCoins, { out: "trade_out", in: "trade_in" }, `trade:${trade.id}`);
    getDb().update(planeCardTrades).set({ status: "accepted", resolvedAt: at }).where(eq(planeCardTrades.id, trade.id)).run();
    refreshUserScore(trade.fromUserId);
    refreshUserScore(trade.toUserId);
    return getTrade(trade.id)!;
  });
}

export function declineTrade(tradeId: number, actorId: string, at = new Date()): TradeWithItems {
  expireIfOverdue(tradeId, at);
  return inTx(() => {
    const trade = requirePending(tradeId, at);
    if (trade.toUserId !== actorId) throw hangarError("forbidden", "Only the person the trade was sent to can decline it.");
    closeTrade(trade, "declined", at);
    return getTrade(trade.id)!;
  });
}

export function cancelTrade(tradeId: number, actorId: string, at = new Date()): TradeWithItems {
  expireIfOverdue(tradeId, at);
  return inTx(() => {
    const trade = requirePending(tradeId, at);
    if (trade.fromUserId !== actorId) throw hangarError("forbidden", "Only the sender can cancel a trade.");
    closeTrade(trade, "cancelled", at);
    return getTrade(trade.id)!;
  });
}

/** Replaces a pending offer with a new one in the other direction (the original becomes "countered"). */
export function counterTrade(
  tradeId: number,
  actorId: string,
  offer: { giveCopyIds: number[]; wantCopyIds: number[]; giveCoins?: number; wantCoins?: number; note?: string | null },
  at = new Date(),
): TradeWithItems {
  expireIfOverdue(tradeId, at);
  return inTx(() => {
    const trade = requirePending(tradeId, at);
    if (trade.toUserId !== actorId) throw hangarError("forbidden", "Only the person the trade was sent to can counter it.");
    closeTrade(trade, "countered", at);
    return createTrade({ ...offer, fromUserId: actorId, toUserId: trade.fromUserId, parentTradeId: trade.id, at });
  });
}

/** Expires overdue pending trades and releases their locks. */
export function expireTrades(at = new Date()): number {
  const overdue = getDb()
    .select()
    .from(planeCardTrades)
    .where(and(eq(planeCardTrades.status, "pending"), lte(planeCardTrades.expiresAt, at)))
    .limit(500)
    .all();
  for (const row of overdue) inTx(() => closeTrade(withItems(row), "expired", at));
  return overdue.length;
}

export function tradesInvolvingCopies(copyIds: number[]): TradeItemRow[] {
  if (!copyIds.length) return [];
  return getDb().select().from(planeCardTradeItems).where(inArray(planeCardTradeItems.copyId, copyIds)).all();
}
