/**
 * Abuse limits for custom commands:
 * - cooldowns (per user / per channel / whole server), in memory;
 * - daily usage limits (per user / whole server), in the database so restarts don't reset them;
 * - runs per server per minute, runs per user per minute and concurrent runs per server;
 * - channels/roles/threads created: per run and per server per hour (database).
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { dreamCommandCreations, dreamCommandDailyUses } from "../../../db/schema.js";
import { StepError, type RunCtx } from "./runtime.js";
import { LIMITS, type CommandCooldowns, type CommandLimits } from "./types.js";

// ── Cooldowns ───────────────────────────────────────────────────────────────────────────────

const cooldowns = new Map<string, number>();

function pruneCooldowns(now: number): void {
  if (cooldowns.size < 20_000) return;
  for (const [key, until] of cooldowns) if (until <= now) cooldowns.delete(key);
}

/** Seconds left on a cooldown, or 0. Does not start one. */
export function cooldownRemaining(guildId: string, command: string, userId: string, channelId: string, cd: CommandCooldowns, now = Date.now()): number {
  const keys: Array<[string, number]> = [
    [`${guildId}:${command}:u:${userId}`, cd.user],
    [`${guildId}:${command}:c:${channelId}`, cd.channel],
    [`${guildId}:${command}:g`, cd.global],
  ];
  let left = 0;
  for (const [key, seconds] of keys) {
    if (seconds <= 0) continue;
    const until = cooldowns.get(key) ?? 0;
    if (until > now) left = Math.max(left, Math.ceil((until - now) / 1000));
  }
  return left;
}

export function startCooldown(guildId: string, command: string, userId: string, channelId: string, cd: CommandCooldowns, now = Date.now()): void {
  pruneCooldowns(now);
  if (cd.user > 0) cooldowns.set(`${guildId}:${command}:u:${userId}`, now + cd.user * 1000);
  if (cd.channel > 0) cooldowns.set(`${guildId}:${command}:c:${channelId}`, now + cd.channel * 1000);
  if (cd.global > 0) cooldowns.set(`${guildId}:${command}:g`, now + cd.global * 1000);
}

export function clearCooldownsForTests(): void {
  cooldowns.clear();
  minuteBuckets.clear();
  running.clear();
}

// ── Daily limits ────────────────────────────────────────────────────────────────────────────

function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function usesToday(guildId: string, command: string, userId: string, day: string): number {
  const row = getDb()
    .select({ uses: dreamCommandDailyUses.uses })
    .from(dreamCommandDailyUses)
    .where(and(eq(dreamCommandDailyUses.guildId, guildId), eq(dreamCommandDailyUses.commandName, command), eq(dreamCommandDailyUses.userId, userId), eq(dreamCommandDailyUses.day, day)))
    .get();
  return row?.uses ?? 0;
}

/** Null when allowed, or the reason it isn't. */
export function dailyLimitProblem(guildId: string, command: string, userId: string, limits: CommandLimits, now = new Date()): string | null {
  if (limits.perUserDaily <= 0 && limits.guildDaily <= 0) return null;
  const day = today(now);
  if (limits.perUserDaily > 0 && usesToday(guildId, command, userId, day) >= limits.perUserDaily) {
    return `You've used /${command} ${limits.perUserDaily} ${limits.perUserDaily === 1 ? "time" : "times"} today, the daily limit. Try again tomorrow (UTC).`;
  }
  if (limits.guildDaily > 0 && usesToday(guildId, command, "", day) >= limits.guildDaily) {
    return `/${command} reached its daily limit for this server. Try again tomorrow (UTC).`;
  }
  return null;
}

export function recordDailyUse(guildId: string, command: string, userId: string, limits: CommandLimits, now = new Date()): void {
  if (limits.perUserDaily <= 0 && limits.guildDaily <= 0) return;
  const day = today(now);
  const db = getDb();
  for (const uid of [userId, ""]) {
    db.insert(dreamCommandDailyUses)
      .values({ guildId, commandName: command, userId: uid, day, uses: 1 })
      .onConflictDoUpdate({
        target: [dreamCommandDailyUses.guildId, dreamCommandDailyUses.commandName, dreamCommandDailyUses.userId, dreamCommandDailyUses.day],
        set: { uses: sql`${dreamCommandDailyUses.uses} + 1` },
      })
      .run();
  }
}

export function pruneDailyUses(now = new Date()): void {
  const cutoff = today(new Date(now.getTime() - 3 * 86400_000));
  getDb().delete(dreamCommandDailyUses).where(lt(dreamCommandDailyUses.day, cutoff)).run();
}

// ── Run rate and concurrency ────────────────────────────────────────────────────────────────

const minuteBuckets = new Map<string, number[]>();
const running = new Map<string, number>();

function hitWindow(key: string, limit: number, now: number): boolean {
  const list = (minuteBuckets.get(key) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= limit) {
    minuteBuckets.set(key, list);
    return false;
  }
  list.push(now);
  minuteBuckets.set(key, list);
  if (minuteBuckets.size > 20_000) {
    for (const [k, v] of minuteBuckets) if (!v.some((t) => now - t < 60_000)) minuteBuckets.delete(k);
  }
  return true;
}

/** Takes a run slot. Returns a release function, or a reason when refused. */
export function acquireRun(guildId: string, userId: string, now = Date.now()): { ok: true; release: () => void } | { ok: false; reason: string } {
  if ((running.get(guildId) ?? 0) >= LIMITS.guildConcurrency) return { ok: false, reason: "Too many custom commands are running in this server right now. Try again in a moment." };
  if (!hitWindow(`u:${guildId}:${userId}`, LIMITS.userRunsPerMinute, now)) return { ok: false, reason: "You're using custom commands too quickly. Try again in a minute." };
  if (!hitWindow(`g:${guildId}`, LIMITS.guildRunsPerMinute, now)) return { ok: false, reason: "Custom commands are being used too quickly in this server. Try again in a minute." };
  running.set(guildId, (running.get(guildId) ?? 0) + 1);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      const left = (running.get(guildId) ?? 1) - 1;
      if (left <= 0) running.delete(guildId);
      else running.set(guildId, left);
    },
  };
}

/** Per-minute limiter for web-style actions (e.g. HTTP). */
export function takeGuildToken(key: string, limit: number, now = Date.now()): boolean {
  return hitWindow(key, limit, now);
}

// ── Creation caps ───────────────────────────────────────────────────────────────────────────

export function creationsLastHour(guildId: string, now = Date.now()): number {
  const row = getDb()
    .select({ n: sql<number>`count(*)` })
    .from(dreamCommandCreations)
    .where(and(eq(dreamCommandCreations.guildId, guildId), gte(dreamCommandCreations.createdAt, new Date(now - 3600_000))))
    .get();
  return Number(row?.n ?? 0);
}

/** Counts one channel/role/thread about to be created, or refuses when over a cap. */
export async function countCreation(ctx: RunCtx, kind: "channel" | "role" | "thread", now = Date.now()): Promise<void> {
  if (ctx.counters.creations >= LIMITS.creationsPerRun) {
    throw new StepError(`A run can create at most ${LIMITS.creationsPerRun} channels, roles or threads.`, "creation_cap");
  }
  if (creationsLastHour(ctx.guild.id, now) >= LIMITS.creationsPerHour) {
    throw new StepError(`Custom commands in this server already created ${LIMITS.creationsPerHour} channels, roles or threads in the last hour. Try again later.`, "creation_cap");
  }
  ctx.counters.creations += 1;
  getDb().insert(dreamCommandCreations).values({ guildId: ctx.guild.id, kind, createdAt: new Date(now) }).run();
}

export function pruneCreations(now = Date.now()): void {
  getDb().delete(dreamCommandCreations).where(lt(dreamCommandCreations.createdAt, new Date(now - 2 * 3600_000))).run();
}
