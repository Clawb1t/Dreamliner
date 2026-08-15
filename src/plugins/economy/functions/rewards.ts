import { and, eq } from "drizzle-orm";
import type { GuildMember } from "discord.js";
import { getDb } from "../../../db/client.js";
import { economyStreaks } from "../../../db/schema.js";
import type { EconomyConfig } from "../../../config/schemas/economy.js";
import {
  EconomyError,
  addXp,
  applyMultiplier,
  ensureGuildCurrencies,
  getPrimaryCurrencyKey,
  grantStartingBalance,
  isGuildPaused,
  mutateMoney,
} from "./money.js";
import { assertCooldown, getActiveRewardBoostBps, setCooldown } from "./inventory.js";

function now() {
  return new Date();
}

/** Format YYYY-MM-DD in a best-effort timezone (falls back to UTC). */
export function calendarDay(timezone: string, date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    /* ignore */
  }
  return date.toISOString().slice(0, 10);
}

function weekKey(timezone: string, date = new Date()): string {
  const day = calendarDay(timezone, date);
  const utc = new Date(`${day}T00:00:00Z`);
  const onejan = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - onejan.getTime()) / 86400000 + onejan.getUTCDay() + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function monthKey(timezone: string, date = new Date()): string {
  return calendarDay(timezone, date).slice(0, 7);
}

export function memberRewardBonusBps(member: GuildMember | null | undefined, config: EconomyConfig): number {
  let bps = 0;
  if (member?.premiumSince && config.booster_multiplier_bps > 0) {
    bps += config.booster_multiplier_bps;
  }
  if (config.multiplier_role_ids.length > 0 && member) {
    const hit = config.multiplier_role_ids.some((id) => member.roles.cache.has(id));
    if (hit) bps += config.role_multiplier_bps;
  }
  return bps;
}

function getStreak(guildId: string, userId: string, key: string) {
  return getDb()
    .select()
    .from(economyStreaks)
    .where(and(eq(economyStreaks.guildId, guildId), eq(economyStreaks.userId, userId), eq(economyStreaks.key, key)))
    .get();
}

function setStreak(
  guildId: string,
  userId: string,
  key: string,
  count: number,
  lastClaimDay: string,
) {
  const existing = getStreak(guildId, userId, key);
  if (existing) {
    getDb()
      .update(economyStreaks)
      .set({ count, lastClaimAt: now(), lastClaimDay })
      .where(
        and(eq(economyStreaks.guildId, guildId), eq(economyStreaks.userId, userId), eq(economyStreaks.key, key)),
      )
      .run();
  } else {
    getDb()
      .insert(economyStreaks)
      .values({
        guildId,
        userId,
        key,
        count,
        lastClaimAt: now(),
        lastClaimDay,
      })
      .run();
  }
}

function previousCalendarDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function claimPeriodic(opts: {
  guildId: string;
  userId: string;
  kind: "daily" | "weekly" | "monthly";
  config: EconomyConfig;
  member?: GuildMember | null;
}) {
  if (!opts.config.modules.rewards) throw new EconomyError("Rewards are disabled.", "invalid");
  if (isGuildPaused(opts.guildId, opts.config)) throw new EconomyError("The economy is paused.", "paused");
  ensureGuildCurrencies(opts.guildId, opts.config);
  grantStartingBalance(opts.guildId, opts.userId, opts.config);

  const tz = opts.config.rewards.timezone || "UTC";
  const period =
    opts.kind === "daily"
      ? calendarDay(tz)
      : opts.kind === "weekly"
        ? weekKey(tz)
        : monthKey(tz);

  const streakKey = opts.kind;
  const existing = getStreak(opts.guildId, opts.userId, streakKey);
  if (existing?.lastClaimDay === period) {
    throw new EconomyError(`You already claimed your ${opts.kind} reward.`, "limit");
  }

  let streak = 1;
  if (opts.kind === "daily" && existing?.lastClaimDay) {
    const yesterday = previousCalendarDay(period);
    const graceMs = opts.config.rewards.daily_streak_grace_hours * 3600_000;
    const lastAt = existing.lastClaimAt?.getTime() ?? 0;
    if (existing.lastClaimDay === yesterday || Date.now() - lastAt <= 86400000 + graceMs) {
      streak = existing.count + 1;
    }
  }

  let base =
    opts.kind === "daily"
      ? opts.config.rewards.daily_amount
      : opts.kind === "weekly"
        ? opts.config.rewards.weekly_amount
        : opts.config.rewards.monthly_amount;

  if (opts.kind === "daily") {
    const capped = Math.min(streak, opts.config.rewards.daily_streak_cap);
    base += capped * opts.config.rewards.daily_streak_bonus;
  }

  const bonusBps =
    memberRewardBonusBps(opts.member, opts.config) + getActiveRewardBoostBps(opts.guildId, opts.userId);
  const amount = applyMultiplier(base, bonusBps);
  const currencyKey = getPrimaryCurrencyKey(opts.guildId, opts.config);

  mutateMoney(
    {
      guildId: opts.guildId,
      userId: opts.userId,
      currencyKey,
      deltaPocket: amount,
      reason: opts.kind,
      idempotencyKey: `${opts.kind}:${opts.guildId}:${opts.userId}:${period}`,
      meta: { streak, base, bonusBps },
    },
    { config: opts.config },
  );

  setStreak(opts.guildId, opts.userId, streakKey, streak, period);
  if (opts.kind === "daily") {
    addXp(opts.guildId, opts.userId, opts.config.progression.xp_per_daily, opts.config);
  }

  return { amount, currencyKey, streak, period, bonusBps };
}

export function claimWork(opts: {
  guildId: string;
  userId: string;
  config: EconomyConfig;
  member?: GuildMember | null;
}) {
  if (!opts.config.modules.work) throw new EconomyError("Work is disabled.", "invalid");
  if (isGuildPaused(opts.guildId, opts.config)) throw new EconomyError("The economy is paused.", "paused");
  ensureGuildCurrencies(opts.guildId, opts.config);
  grantStartingBalance(opts.guildId, opts.userId, opts.config);
  assertCooldown(opts.guildId, opts.userId, "work");

  const min = opts.config.rewards.work_min;
  const max = Math.max(min, opts.config.rewards.work_max);
  const base = min + Math.floor(Math.random() * (max - min + 1));
  const bonusBps =
    memberRewardBonusBps(opts.member, opts.config) + getActiveRewardBoostBps(opts.guildId, opts.userId);
  const amount = applyMultiplier(base, bonusBps);
  const currencyKey = getPrimaryCurrencyKey(opts.guildId, opts.config);

  mutateMoney(
    {
      guildId: opts.guildId,
      userId: opts.userId,
      currencyKey,
      deltaPocket: amount,
      reason: "work",
      meta: { base, bonusBps },
    },
    { config: opts.config },
  );
  setCooldown(
    opts.guildId,
    opts.userId,
    "work",
    new Date(Date.now() + opts.config.rewards.work_cooldown_seconds * 1000),
  );
  addXp(opts.guildId, opts.userId, opts.config.progression.xp_per_work, opts.config);
  return { amount, currencyKey, bonusBps };
}

export function getRewardStatus(guildId: string, userId: string, config: EconomyConfig) {
  const tz = config.rewards.timezone || "UTC";
  const daily = getStreak(guildId, userId, "daily");
  const weekly = getStreak(guildId, userId, "weekly");
  const monthly = getStreak(guildId, userId, "monthly");
  return {
    daily: {
      claimed: daily?.lastClaimDay === calendarDay(tz),
      streak: daily?.count ?? 0,
      lastDay: daily?.lastClaimDay ?? null,
    },
    weekly: {
      claimed: weekly?.lastClaimDay === weekKey(tz),
      lastPeriod: weekly?.lastClaimDay ?? null,
    },
    monthly: {
      claimed: monthly?.lastClaimDay === monthKey(tz),
      lastPeriod: monthly?.lastClaimDay ?? null,
    },
  };
}
