import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { aviaUsage } from "../../db/schema.js";

/**
 * Daily message limits for Avia, the help centre's AI assistant. The website asks before every
 * message; this is the authoritative count (the site's own per-instance limiter is only a backstop).
 *
 * Subjects: `user:<discordId>` for signed-in people, `ip:<salted hash>` for everyone else (the site
 * hashes the IP before it ever reaches the bot), and `*` for the global total.
 */

const GLOBAL = "*";

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function aviaLimits() {
  return {
    anonymous: envInt("AVIA_DAILY_ANON", 15),
    signedIn: envInt("AVIA_DAILY_USER", 50),
    global: envInt("AVIA_DAILY_GLOBAL", 5000),
  };
}

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function nextReset(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return d.toISOString();
}

const SUBJECT = /^(?:user:\d{17,20}|ip:[a-f0-9]{16,64})$/;

export function validAviaSubject(subject: unknown): subject is string {
  return typeof subject === "string" && SUBJECT.test(subject);
}

export type AviaUsageResult = { allowed: boolean; remaining: number; limit: number; resetAt: string; reason?: "user" | "global" };

function count(subject: string, day: string): number {
  const row = getDb().select({ messages: aviaUsage.messages }).from(aviaUsage).where(and(eq(aviaUsage.subject, subject), eq(aviaUsage.day, day))).get();
  return row?.messages ?? 0;
}

function bump(subject: string, day: string, now: Date): void {
  getDb()
    .insert(aviaUsage)
    .values({ subject, day, messages: 1, tokens: 0, updatedAt: now })
    .onConflictDoUpdate({ target: [aviaUsage.subject, aviaUsage.day], set: { messages: sql`${aviaUsage.messages} + 1`, updatedAt: now } })
    .run();
}

/**
 * Checks the limit for one message and, when allowed, counts it. `peek` only reports what's left
 * (used to show "12 messages left today" before anything is sent).
 */
export function takeAviaMessage(subject: string, options: { peek?: boolean; now?: Date } = {}): AviaUsageResult {
  const now = options.now ?? new Date();
  const day = utcDay(now);
  const limits = aviaLimits();
  const limit = subject.startsWith("user:") ? limits.signedIn : limits.anonymous;
  const used = count(subject, day);
  const resetAt = nextReset(now);
  if (count(GLOBAL, day) >= limits.global) return { allowed: false, remaining: 0, limit, resetAt, reason: "global" };
  if (used >= limit) return { allowed: false, remaining: 0, limit, resetAt, reason: "user" };
  if (options.peek) return { allowed: true, remaining: limit - used, limit, resetAt };
  bump(subject, day, now);
  bump(GLOBAL, day, now);
  return { allowed: true, remaining: limit - used - 1, limit, resetAt };
}

/** Adds the tokens a finished answer used, for cost tracking. */
export function recordAviaTokens(subject: string, tokens: number, now = new Date()): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  const day = utcDay(now);
  for (const s of [subject, GLOBAL]) {
    getDb()
      .update(aviaUsage)
      .set({ tokens: sql`${aviaUsage.tokens} + ${Math.floor(tokens)}`, updatedAt: now })
      .where(and(eq(aviaUsage.subject, s), eq(aviaUsage.day, day)))
      .run();
  }
}

/** Drops rows older than a week (called opportunistically). */
export function pruneAviaUsage(now = new Date()): void {
  const cutoff = utcDay(new Date(now.getTime() - 7 * 86_400_000));
  getDb().delete(aviaUsage).where(lt(aviaUsage.day, cutoff)).run();
}

/** Personal data: a signed-in user's usage rows. */
export function aviaUsageForUser(userId: string) {
  return getDb().select().from(aviaUsage).where(eq(aviaUsage.subject, `user:${userId}`)).all();
}

export function deleteAviaUsageForUser(userId: string): number {
  return getDb().delete(aviaUsage).where(eq(aviaUsage.subject, `user:${userId}`)).returning().all().length;
}
