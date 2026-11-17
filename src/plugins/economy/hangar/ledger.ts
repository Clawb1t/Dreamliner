import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { economyGlobalAccounts, planeCoinLedger, planePartsLedger } from "../../../db/schema.js";
import { ensureGlobalAccount, round2 } from "../functions/money.js";
import { hangarError } from "./errors.js";

/**
 * The only way the card system moves global coins or Parts. Every movement is one ledger row.
 *
 * Coins: there is deliberately no exported "credit" function. Coins can only be burned (a debit
 * with no counterparty) or transferred (a debit and an equal credit in the same transaction), so
 * the card system can never add coins to the economy. The coin-conservation test relies on this.
 */

export type CoinBurnKind = "pack" | "market_fee" | "repaint" | "hangar_slot";
export type CoinTransferKind = { out: "market_buy" | "trade_out"; in: "market_sale" | "trade_in" };
export const COIN_BURN_KINDS: readonly CoinBurnKind[] = ["pack", "market_fee", "repaint", "hangar_slot"];

export type PartsKind = "salvage" | "flight" | "set_bonus" | "boarding_streak" | "craft" | "upgrade" | "grant";
export const PARTS_EARN_KINDS: readonly PartsKind[] = ["salvage", "flight", "set_bonus", "boarding_streak", "grant"];
export const PARTS_SPEND_KINDS: readonly PartsKind[] = ["craft", "upgrade"];

/** Runs `fn` in one SQLite transaction (nested calls become savepoints). */
export function inTx<T>(fn: () => T): T {
  return getDb().transaction(() => fn());
}

function nowDate(): Date {
  return new Date();
}

function validAmount(amount: number): number {
  const value = round2(amount);
  if (!Number.isFinite(value) || value <= 0) throw hangarError("invalid", "Amount must be positive.");
  return value;
}

function debit(userId: string, amount: number): number {
  const account = ensureGlobalAccount(userId);
  if (account.balance + 1e-9 < amount) {
    throw hangarError("insufficient_coins", "You need {amount} coins for that.", { amount: amount.toFixed(2) });
  }
  const balance = round2(account.balance - amount);
  getDb().update(economyGlobalAccounts).set({ balance, updatedAt: nowDate() }).where(eq(economyGlobalAccounts.userId, userId)).run();
  return balance;
}

function credit(userId: string, amount: number): number {
  const account = ensureGlobalAccount(userId);
  const balance = round2(account.balance + amount);
  getDb().update(economyGlobalAccounts).set({ balance, updatedAt: nowDate() }).where(eq(economyGlobalAccounts.userId, userId)).run();
  return balance;
}

function logCoins(userId: string, delta: number, kind: string, counterpartyId: string | null, ref: string | null): void {
  getDb().insert(planeCoinLedger).values({ userId, delta, kind, counterpartyId, ref, createdAt: nowDate() }).run();
}

/** Removes coins from circulation. Returns the payer's new balance. */
export function burnCoins(userId: string, amount: number, kind: CoinBurnKind, ref: string | null = null): number {
  const value = validAmount(amount);
  return inTx(() => {
    const balance = debit(userId, value);
    logCoins(userId, -value, kind, null, ref);
    return balance;
  });
}

/** Moves coins between two players, zero-sum. Returns both new balances. */
export function transferCoins(
  fromId: string,
  toId: string,
  amount: number,
  kinds: CoinTransferKind,
  ref: string | null = null,
): { fromBalance: number; toBalance: number } {
  if (fromId === toId) throw hangarError("invalid", "You can't pay yourself.");
  const value = validAmount(amount);
  return inTx(() => {
    const fromBalance = debit(fromId, value);
    const toBalance = credit(toId, value);
    logCoins(fromId, -value, kinds.out, toId, ref);
    logCoins(toId, value, kinds.in, fromId, ref);
    return { fromBalance, toBalance };
  });
}

export function getCoinBalance(userId: string): number {
  return ensureGlobalAccount(userId).balance;
}

// ── Parts ────────────────────────────────────────────────────────────────────

export function getPartsBalance(userId: string): number {
  const row = getDb()
    .select({ total: sql<number>`COALESCE(SUM(${planePartsLedger.delta}), 0)` })
    .from(planePartsLedger)
    .where(eq(planePartsLedger.userId, userId))
    .get();
  return Number(row?.total ?? 0);
}

export function grantParts(
  userId: string,
  amount: number,
  kind: PartsKind,
  opts: { copyId?: number | null; ref?: string | null } = {},
): number {
  const value = Math.floor(amount);
  if (value <= 0) return getPartsBalance(userId);
  getDb()
    .insert(planePartsLedger)
    .values({ userId, delta: value, kind, copyId: opts.copyId ?? null, ref: opts.ref ?? null, createdAt: nowDate() })
    .run();
  return getPartsBalance(userId);
}

export function spendParts(
  userId: string,
  amount: number,
  kind: PartsKind,
  opts: { copyId?: number | null; ref?: string | null } = {},
): number {
  const value = Math.floor(amount);
  if (value <= 0) throw hangarError("invalid", "Amount must be positive.");
  return inTx(() => {
    const balance = getPartsBalance(userId);
    if (balance < value) {
      throw hangarError("insufficient_parts", "You need {amount} Parts for that (you have {balance}).", { amount: value, balance });
    }
    getDb()
      .insert(planePartsLedger)
      .values({ userId, delta: -value, kind, copyId: opts.copyId ?? null, ref: opts.ref ?? null, createdAt: nowDate() })
      .run();
    return balance - value;
  });
}

/** Recent Parts movements for one user, newest first. */
export function listPartsHistory(userId: string, limit = 25) {
  return getDb()
    .select()
    .from(planePartsLedger)
    .where(eq(planePartsLedger.userId, userId))
    .orderBy(sql`${planePartsLedger.id} DESC`)
    .limit(limit)
    .all();
}

/** Whether a set-completion bonus or similar keyed Parts grant was already paid. */
export function hasPartsGrant(userId: string, kind: PartsKind, ref: string): boolean {
  return Boolean(
    getDb()
      .select({ id: planePartsLedger.id })
      .from(planePartsLedger)
      .where(and(eq(planePartsLedger.userId, userId), eq(planePartsLedger.kind, kind), eq(planePartsLedger.ref, ref)))
      .get(),
  );
}
