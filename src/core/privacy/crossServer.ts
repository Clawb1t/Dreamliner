/**
 * Viewer-aware readers for one user's activity across every server. Each one asks the gate
 * (`canViewCrossServerData`) first and then returns the live value, the 00:00 UTC snapshot, or
 * nothing. Viewer-facing code reads global per-user stats through here, never the tables directly
 * (crossServer.test.ts checks that).
 *
 * Tracking itself is untouched: these only shape what someone else is shown.
 */
import { and, count, eq, gt, gte, inArray, lt, notInArray, sql } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import {
  economyGlobalAccounts,
  guildMessageCounts,
  guildStatsUserDaily,
  userHourlyActivity,
  userMessageCounts,
} from "../../db/schema.js";
import { canViewCrossServerData, listHiddenFromGlobalBoards } from "./ghostMode.js";
import {
  dayStartValue,
  utcDate,
  utcDayStart,
  type CrossServerAccess,
} from "./policy.js";

export type GlobalStatsView =
  | { access: "hidden" }
  | {
      access: "live" | "snapshot";
      totalMessages: number;
      /** Among users shown on the global boards (Ghost Mode users aren't counted ahead of anyone). */
      globalRank: number | null;
      activeMessagers: number;
      serverCount: number;
      /** Exact time of their most recent tracked message, for "Active now" / "Last seen 5m ago".
       *  Shown to everyone unless Ghost Mode hides it (then the whole view is "hidden"). */
      lastActiveAt: Date | null;
      /** ISO time the numbers are from: null when live. */
      asOf: string | null;
    };

/** Messages today across every server, from the daily table (fallback for pre-trigger rows). */
function todaysMessages(userId: string, now: Date): number {
  const row = getDb()
    .select({ total: sql<number>`coalesce(sum(${guildStatsUserDaily.messages}), 0)` })
    .from(guildStatsUserDaily)
    .where(and(eq(guildStatsUserDaily.userId, userId), eq(guildStatsUserDaily.statDate, utcDate(now))))
    .get();
  return Number(row?.total ?? 0);
}

/** Lifetime global messages and last message time as of 00:00 UTC today. */
export function snapshotGlobalMessages(userId: string, now = new Date()): { count: number; lastAt: Date | null } {
  const row = getDb().select().from(userMessageCounts).where(eq(userMessageCounts.userId, userId)).get();
  if (!row) return { count: 0, lastAt: null };
  const dayStart = utcDayStart(now);
  const count = dayStartValue({ live: row.count, dayStart: row.dayStartCount, dayStartDate: row.dayStartDate }, now);
  const lastAt = dayStartValue({ live: row.lastMessageAt, dayStart: row.dayStartLastAt, dayStartDate: row.dayStartDate }, now);
  if (count !== null) return { count, lastAt: lastAt ?? null };
  // Untouched since before the triggers existed: unchanged today, or estimate from today's dailies.
  if (!row.lastMessageAt || row.lastMessageAt < dayStart) return { count: row.count, lastAt: row.lastMessageAt ?? null };
  return { count: Math.max(0, row.count - todaysMessages(userId, now)), lastAt: null };
}

/** 1 + visible users ahead of `count` on the global messages board. */
export function visibleGlobalRank(messages: number, hidden: ReadonlySet<string>, subjectId?: string): number | null {
  if (messages <= 0) return null;
  // The subject's own live row never counts ahead of their snapshot.
  const hiddenIds = [...hidden, ...(subjectId ? [subjectId] : [])];
  const where = hiddenIds.length
    ? and(gt(userMessageCounts.count, messages), notInArray(userMessageCounts.userId, hiddenIds))
    : gt(userMessageCounts.count, messages);
  const row = getDb().select({ total: count() }).from(userMessageCounts).where(where).get();
  return Number(row?.total ?? 0) + 1;
}

function visibleActiveMessagers(hidden: ReadonlySet<string>): number {
  const hiddenIds = [...hidden];
  const where = hiddenIds.length
    ? and(gte(userMessageCounts.count, 1), notInArray(userMessageCounts.userId, hiddenIds))
    : gte(userMessageCounts.count, 1);
  return Number(getDb().select({ total: count() }).from(userMessageCounts).where(where).get()?.total ?? 0);
}

/** Servers with any tracked message. For a snapshot, servers first messaged in today don't count. */
function serverCount(userId: string, access: CrossServerAccess, now: Date): number {
  const db = getDb();
  const total = Number(db.select({ total: count() }).from(guildMessageCounts).where(eq(guildMessageCounts.userId, userId)).get()?.total ?? 0);
  if (access === "live") return total;
  return total - firstMessagedToday(userId, now).size;
}

/** Guilds whose whole lifetime count for this user is from today, plus today's count per guild. */
function todayByGuild(userId: string, now: Date): Map<string, number> {
  const rows = getDb()
    .select({ guildId: guildStatsUserDaily.guildId, messages: guildStatsUserDaily.messages })
    .from(guildStatsUserDaily)
    .where(and(eq(guildStatsUserDaily.userId, userId), eq(guildStatsUserDaily.statDate, utcDate(now))))
    .all();
  return new Map(rows.map((row) => [row.guildId, Number(row.messages ?? 0)]));
}

function firstMessagedToday(userId: string, now: Date): Set<string> {
  const today = todayByGuild(userId, now);
  if (!today.size) return new Set();
  const rows = getDb()
    .select({ guildId: guildMessageCounts.guildId, count: guildMessageCounts.count })
    .from(guildMessageCounts)
    .where(and(eq(guildMessageCounts.userId, userId), inArray(guildMessageCounts.guildId, [...today.keys()])))
    .all();
  return new Set(rows.filter((row) => row.count <= (today.get(row.guildId) ?? 0)).map((row) => row.guildId));
}

/** Per-server lifetime counts for one user: live, or as of 00:00 UTC (servers new today dropped). */
export function guildCountsFor(userId: string, access: CrossServerAccess, now = new Date()): Array<{ guildId: string; count: number }> {
  if (access === "hidden") return [];
  const rows = getDb()
    .select({ guildId: guildMessageCounts.guildId, count: guildMessageCounts.count })
    .from(guildMessageCounts)
    .where(eq(guildMessageCounts.userId, userId))
    .all();
  if (access === "live") return rows;
  const today = todayByGuild(userId, now);
  return rows.map((row) => ({ guildId: row.guildId, count: row.count - (today.get(row.guildId) ?? 0) })).filter((row) => row.count > 0);
}

/** The global stats block (/rank global, /profile, the profile page) as `viewerId` may see it. */
export function globalStatsFor(viewerId: string | null | undefined, subjectId: string, now = new Date()): GlobalStatsView {
  const access = canViewCrossServerData(viewerId, subjectId, now);
  if (access === "hidden") return { access };
  const hidden = listHiddenFromGlobalBoards(now);
  const live = access === "live";
  const row = getDb().select().from(userMessageCounts).where(eq(userMessageCounts.userId, subjectId)).get();
  // Numbers: live for you and your allow list, 00:00 UTC for everyone else. Last seen: the real
  // time for everyone (a product decision: members expect "Last seen 5m ago"); only Ghost Mode
  // hides it, which returned above.
  const totalMessages = live ? (row?.count ?? 0) : snapshotGlobalMessages(subjectId, now).count;
  const lastAt = row?.lastMessageAt ?? null;
  return {
    access,
    totalMessages,
    globalRank: visibleGlobalRank(totalMessages, hidden, subjectId),
    activeMessagers: visibleActiveMessagers(hidden),
    serverCount: serverCount(subjectId, access, now),
    lastActiveAt: lastAt,
    asOf: live ? null : utcDayStart(now).toISOString(),
  };
}

/** Just the lifetime global message count (/info, /stats user, dashboard member stats). Null when hidden. */
export function globalMessageCountFor(viewerId: string | null | undefined, subjectId: string, now = new Date()): number | null {
  const access = canViewCrossServerData(viewerId, subjectId, now);
  if (access === "hidden") return null;
  if (access === "live") return getDb().select().from(userMessageCounts).where(eq(userMessageCounts.userId, subjectId)).get()?.count ?? 0;
  return snapshotGlobalMessages(subjectId, now).count;
}

/** Message totals per day across every server. Others only get days up to yesterday. */
export function dailyActivityFor(
  viewerId: string | null | undefined,
  subjectId: string,
  days: number,
  now = new Date(),
): { access: CrossServerAccess; daily: Array<{ date: string; messages: number }> } {
  const access = canViewCrossServerData(viewerId, subjectId, now);
  if (access === "hidden") return { access, daily: [] };
  const end = access === "live" ? utcDayStart(now) : new Date(utcDayStart(now).getTime() - 86_400_000);
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) dates.push(utcDate(new Date(end.getTime() - i * 86_400_000)));
  const rows = getDb()
    .select({ date: guildStatsUserDaily.statDate, messages: sql<number>`coalesce(sum(${guildStatsUserDaily.messages}), 0)` })
    .from(guildStatsUserDaily)
    .where(and(eq(guildStatsUserDaily.userId, subjectId), gte(guildStatsUserDaily.statDate, dates[0]!), access === "live" ? undefined : lt(guildStatsUserDaily.statDate, utcDate(now))))
    .groupBy(guildStatsUserDaily.statDate)
    .all();
  const map = new Map(rows.map((row) => [row.date, Number(row.messages ?? 0)]));
  return { access, daily: dates.map((date) => ({ date, messages: map.get(date) ?? 0 })) };
}

/** Lifetime messages per UTC hour (0-23). Others get the 00:00 UTC values. Empty when hidden. */
export function hourlyActivityFor(viewerId: string | null | undefined, subjectId: string, now = new Date()): { access: CrossServerAccess; hours: number[] } {
  const access = canViewCrossServerData(viewerId, subjectId, now);
  if (access === "hidden") return { access, hours: [] };
  const rows = getDb().select().from(userHourlyActivity).where(eq(userHourlyActivity.userId, subjectId)).all();
  const hours = new Array(24).fill(0) as number[];
  for (const row of rows) {
    if (row.hourUtc < 0 || row.hourUtc > 23) continue;
    hours[row.hourUtc] = access === "live" ? row.count : (dayStartValue({ live: row.count, dayStart: row.dayStartCount, dayStartDate: row.dayStartDate }, now) ?? row.count);
  }
  return { access, hours };
}

/** A global coin balance and /daily streak (they change with activity anywhere). Null when hidden. */
export function globalEconomyFor(viewerId: string | null | undefined, subjectId: string, now = new Date()): { access: CrossServerAccess; balance: number; streak: number } | null {
  const access = canViewCrossServerData(viewerId, subjectId, now);
  if (access === "hidden") return null;
  const row = getDb().select().from(economyGlobalAccounts).where(eq(economyGlobalAccounts.userId, subjectId)).get();
  if (!row) return { access, balance: 0, streak: 0 };
  if (access === "live") return { access, balance: Number(row.balance) || 0, streak: Number(row.dailyStreak) || 0 };
  const balance = dayStartValue({ live: row.balance, dayStart: row.dayStartBalance, dayStartDate: row.dayStartDate }, now) ?? row.balance;
  const streak = dayStartValue({ live: row.dailyStreak, dayStart: row.dayStartStreak, dayStartDate: row.dayStartDate }, now) ?? row.dailyStreak;
  return { access, balance: Number(balance) || 0, streak: Number(streak) || 0 };
}
