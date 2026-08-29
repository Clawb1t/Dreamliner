import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { economyGlobalAccounts, economyServerAccounts } from "../../../db/schema.js";

/** Round to 2 decimal places to keep the low-value decimal currencies tidy. */
export function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function now() {
  return new Date();
}

// ── Global (bot-wide) account ────────────────────────────────────────────────

export function ensureGlobalAccount(userId: string) {
  const db = getDb();
  const existing = db
    .select()
    .from(economyGlobalAccounts)
    .where(eq(economyGlobalAccounts.userId, userId))
    .get();
  if (existing) return existing;
  db.insert(economyGlobalAccounts)
    .values({ userId, balance: 0, dailyStreak: 0, createdAt: now(), updatedAt: now() })
    .run();
  return db.select().from(economyGlobalAccounts).where(eq(economyGlobalAccounts.userId, userId)).get()!;
}

export function getGlobalBalance(userId: string): number {
  return ensureGlobalAccount(userId).balance;
}

export function creditGlobal(userId: string, amount: number): number {
  const db = getDb();
  const account = ensureGlobalAccount(userId);
  const balance = round2(account.balance + amount);
  db.update(economyGlobalAccounts)
    .set({ balance, updatedAt: now() })
    .where(eq(economyGlobalAccounts.userId, userId))
    .run();
  return balance;
}

export class InsufficientFundsError extends Error {
  constructor(message = "Not enough coins.") {
    super(message);
    this.name = "InsufficientFundsError";
  }
}

/** Guarded debit — throws InsufficientFundsError rather than allowing a negative balance. */
export function spendGlobal(userId: string, amount: number): number {
  if (!(amount > 0)) throw new Error("amount must be positive");
  const db = getDb();
  const account = ensureGlobalAccount(userId);
  if (account.balance < amount) throw new InsufficientFundsError();
  const balance = round2(account.balance - amount);
  db.update(economyGlobalAccounts).set({ balance, updatedAt: now() }).where(eq(economyGlobalAccounts.userId, userId)).run();
  return balance;
}

export function canClaimGlobalMessage(userId: string, cooldownSeconds: number): boolean {
  const account = ensureGlobalAccount(userId);
  if (!account.lastMessageAt) return true;
  return Date.now() - account.lastMessageAt.getTime() >= cooldownSeconds * 1_000;
}

export function markGlobalMessageClaimed(userId: string) {
  getDb()
    .update(economyGlobalAccounts)
    .set({ lastMessageAt: now() })
    .where(eq(economyGlobalAccounts.userId, userId))
    .run();
}

export type DailyClaimResult = { amount: number; streak: number; nextAt: Date };

const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
const DAILY_STREAK_GRACE_MS = 48 * 60 * 60 * 1_000;

export function claimGlobalDaily(userId: string, amount: number): DailyClaimResult | null {
  const account = ensureGlobalAccount(userId);
  const last = account.lastDailyAt;
  if (last && Date.now() - last.getTime() < DAILY_COOLDOWN_MS) return null;

  const streak = last && Date.now() - last.getTime() < DAILY_STREAK_GRACE_MS ? account.dailyStreak + 1 : 1;
  const balance = round2(account.balance + amount);
  const claimedAt = now();
  getDb()
    .update(economyGlobalAccounts)
    .set({ balance, lastDailyAt: claimedAt, dailyStreak: streak, updatedAt: claimedAt })
    .where(eq(economyGlobalAccounts.userId, userId))
    .run();
  return { amount, streak, nextAt: new Date(claimedAt.getTime() + DAILY_COOLDOWN_MS) };
}

// ── Server (per-guild) account ───────────────────────────────────────────────

export function ensureServerAccount(guildId: string, userId: string) {
  const db = getDb();
  const existing = db
    .select()
    .from(economyServerAccounts)
    .where(and(eq(economyServerAccounts.guildId, guildId), eq(economyServerAccounts.userId, userId)))
    .get();
  if (existing) return existing;
  db.insert(economyServerAccounts)
    .values({ guildId, userId, balance: 0, dailyStreak: 0, createdAt: now(), updatedAt: now() })
    .run();
  return db
    .select()
    .from(economyServerAccounts)
    .where(and(eq(economyServerAccounts.guildId, guildId), eq(economyServerAccounts.userId, userId)))
    .get()!;
}

export function getServerBalance(guildId: string, userId: string): number {
  return ensureServerAccount(guildId, userId).balance;
}

export function creditServer(guildId: string, userId: string, amount: number): number {
  const db = getDb();
  const account = ensureServerAccount(guildId, userId);
  const balance = round2(account.balance + amount);
  db.update(economyServerAccounts)
    .set({ balance, updatedAt: now() })
    .where(and(eq(economyServerAccounts.guildId, guildId), eq(economyServerAccounts.userId, userId)))
    .run();
  return balance;
}

export function canClaimServerMessage(guildId: string, userId: string, cooldownSeconds: number): boolean {
  const account = ensureServerAccount(guildId, userId);
  if (!account.lastMessageAt) return true;
  return Date.now() - account.lastMessageAt.getTime() >= cooldownSeconds * 1_000;
}

export function markServerMessageClaimed(guildId: string, userId: string) {
  getDb()
    .update(economyServerAccounts)
    .set({ lastMessageAt: now() })
    .where(and(eq(economyServerAccounts.guildId, guildId), eq(economyServerAccounts.userId, userId)))
    .run();
}

export function claimServerDaily(guildId: string, userId: string, amount: number): DailyClaimResult | null {
  const account = ensureServerAccount(guildId, userId);
  const last = account.lastDailyAt;
  if (last && Date.now() - last.getTime() < DAILY_COOLDOWN_MS) return null;

  const streak = last && Date.now() - last.getTime() < DAILY_STREAK_GRACE_MS ? account.dailyStreak + 1 : 1;
  const balance = round2(account.balance + amount);
  const claimedAt = now();
  getDb()
    .update(economyServerAccounts)
    .set({ balance, lastDailyAt: claimedAt, dailyStreak: streak, updatedAt: claimedAt })
    .where(and(eq(economyServerAccounts.guildId, guildId), eq(economyServerAccounts.userId, userId)))
    .run();
  return { amount, streak, nextAt: new Date(claimedAt.getTime() + DAILY_COOLDOWN_MS) };
}
