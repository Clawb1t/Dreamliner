import { and, asc, count, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import {
  guildMessageCounts,
  guildStatsChannelDaily,
  guildStatsUserDaily,
  logMessages,
} from "../../../db/schema.js";
import { dateRange, dateRangeInclusive, getDailyTotals, getFilledDailyStats, isAllTimeWindow, statDate, windowSince } from "./daily.js";

function dailySinceFilter(since: string | null, column: Parameters<typeof gte>[0]): SQL | undefined {
  return since ? gte(column, since) : undefined;
}

/** Lifetime or window total from utility message counters (user lifetime / all-time user leaderboards). */
export async function getTrackedMessagesTotal(guildId: string, days: number): Promise<number> {
  if (isAllTimeWindow(days)) {
    return getTotalGuildMessages(guildId);
  }
  const daily = await getFilledDailyStats(guildId, days);
  return daily.reduce((sum, row) => sum + row.messages, 0);
}

/** Lifetime or window total from stats daily tables (channel leaderboards / daily-scoped shares). */
export async function getTrackedDailyMessagesTotal(guildId: string, days: number): Promise<number> {
  if (isAllTimeWindow(days)) {
    const totals = await getDailyTotals(guildId);
    return totals.messages;
  }
  const daily = await getFilledDailyStats(guildId, days);
  return daily.reduce((sum, row) => sum + row.messages, 0);
}

export async function getTotalGuildMessages(guildId: string): Promise<number> {
  const db = getDb();
  const row = await db
    .select({ total: sql<number>`coalesce(sum(${guildMessageCounts.count}), 0)` })
    .from(guildMessageCounts)
    .where(eq(guildMessageCounts.guildId, guildId))
    .get();
  return Number(row?.total ?? 0);
}

export async function getChannelTrackedMessages(guildId: string, channelId: string): Promise<number> {
  const db = getDb();
  const row = await db
    .select({ total: count() })
    .from(logMessages)
    .where(and(eq(logMessages.guildId, guildId), eq(logMessages.channelId, channelId)))
    .get();
  return row?.total ?? 0;
}

export async function getTopMessagers(guildId: string, limit = 5): Promise<{ userId: string; count: number }[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(guildMessageCounts)
    .where(eq(guildMessageCounts.guildId, guildId))
    .orderBy(sql`${guildMessageCounts.count} desc`)
    .limit(limit);
  return rows.map((row) => ({ userId: row.userId, count: row.count }));
}

export async function getActiveMessagerCount(guildId: string): Promise<number> {
  const db = getDb();
  const row = await db
    .select({ total: count() })
    .from(guildMessageCounts)
    .where(and(eq(guildMessageCounts.guildId, guildId), gte(guildMessageCounts.count, 1)))
    .get();
  return row?.total ?? 0;
}

/** Lifetime message count for a single user in a guild. */
export async function getUserMessageCount(guildId: string, userId: string): Promise<number> {
  const db = getDb();
  const row = await db
    .select({ count: guildMessageCounts.count })
    .from(guildMessageCounts)
    .where(and(eq(guildMessageCounts.guildId, guildId), eq(guildMessageCounts.userId, userId)))
    .get();
  return row?.count ?? 0;
}

export async function getUserMessageRank(guildId: string, _userId: string, userCount: number): Promise<number> {
  if (userCount <= 0) return 0;
  const db = getDb();
  const row = await db
    .select({ total: count() })
    .from(guildMessageCounts)
    .where(and(eq(guildMessageCounts.guildId, guildId), sql`${guildMessageCounts.count} > ${userCount}`))
    .get();
  return (row?.total ?? 0) + 1;
}

export async function getTopChannelsByDaily(
  guildId: string,
  days = 14,
  limit = 5,
): Promise<{ channelId: string; count: number }[]> {
  const db = getDb();
  const since = windowSince(days);
  const filters = [eq(guildStatsChannelDaily.guildId, guildId)];
  const sinceFilter = dailySinceFilter(since, guildStatsChannelDaily.statDate);
  if (sinceFilter) filters.push(sinceFilter);

  const rows = await db
    .select({
      channelId: guildStatsChannelDaily.channelId,
      count: sql<number>`coalesce(sum(${guildStatsChannelDaily.messages}), 0)`,
    })
    .from(guildStatsChannelDaily)
    .where(and(...filters))
    .groupBy(guildStatsChannelDaily.channelId)
    .orderBy(desc(sql`coalesce(sum(${guildStatsChannelDaily.messages}), 0)`))
    .limit(limit);

  return rows.map((row) => ({ channelId: row.channelId, count: Number(row.count ?? 0) }));
}

export async function getTopUsersByDaily(
  guildId: string,
  days = 14,
  limit = 5,
): Promise<{ userId: string; count: number }[]> {
  const db = getDb();
  const since = windowSince(days);
  const filters = [eq(guildStatsUserDaily.guildId, guildId)];
  const sinceFilter = dailySinceFilter(since, guildStatsUserDaily.statDate);
  if (sinceFilter) filters.push(sinceFilter);

  const rows = await db
    .select({
      userId: guildStatsUserDaily.userId,
      count: sql<number>`coalesce(sum(${guildStatsUserDaily.messages}), 0)`,
    })
    .from(guildStatsUserDaily)
    .where(and(...filters))
    .groupBy(guildStatsUserDaily.userId)
    .orderBy(desc(sql`coalesce(sum(${guildStatsUserDaily.messages}), 0)`))
    .limit(limit);

  return rows.map((row) => ({ userId: row.userId, count: Number(row.count ?? 0) }));
}

export async function getChannelDailyTotal(guildId: string, channelId: string): Promise<number> {
  const db = getDb();
  const row = await db
    .select({ total: sql<number>`coalesce(sum(${guildStatsChannelDaily.messages}), 0)` })
    .from(guildStatsChannelDaily)
    .where(and(eq(guildStatsChannelDaily.guildId, guildId), eq(guildStatsChannelDaily.channelId, channelId)))
    .get();
  return Number(row?.total ?? 0);
}

export async function getUserDailyWindowTotal(guildId: string, userId: string, days: number): Promise<number> {
  const db = getDb();
  const since = windowSince(days);
  const filters = [eq(guildStatsUserDaily.guildId, guildId), eq(guildStatsUserDaily.userId, userId)];
  const sinceFilter = dailySinceFilter(since, guildStatsUserDaily.statDate);
  if (sinceFilter) filters.push(sinceFilter);

  const row = await db
    .select({ total: sql<number>`coalesce(sum(${guildStatsUserDaily.messages}), 0)` })
    .from(guildStatsUserDaily)
    .where(and(...filters))
    .get();
  return Number(row?.total ?? 0);
}

export async function getFilledDailyActiveUsers(
  guildId: string,
  days = 14,
): Promise<{ statDate: string; count: number }[]> {
  const db = getDb();

  if (isAllTimeWindow(days)) {
    const rows = await db
      .select({
        statDate: guildStatsUserDaily.statDate,
        count: sql<number>`count(distinct ${guildStatsUserDaily.userId})`,
      })
      .from(guildStatsUserDaily)
      .where(and(eq(guildStatsUserDaily.guildId, guildId), sql`${guildStatsUserDaily.messages} > 0`))
      .groupBy(guildStatsUserDaily.statDate)
      .orderBy(asc(guildStatsUserDaily.statDate));
    if (rows.length === 0) return [];
    const dates = dateRangeInclusive(rows[0]!.statDate, statDate());
    const byDate = new Map(rows.map((row) => [row.statDate, Number(row.count ?? 0)]));
    return dates.map((date) => ({ statDate: date, count: byDate.get(date) ?? 0 }));
  }

  const dates = dateRange(days);
  const since = dates[0]!;
  const rows = await db
    .select({
      statDate: guildStatsUserDaily.statDate,
      count: sql<number>`count(distinct ${guildStatsUserDaily.userId})`,
    })
    .from(guildStatsUserDaily)
    .where(
      and(
        eq(guildStatsUserDaily.guildId, guildId),
        gte(guildStatsUserDaily.statDate, since),
        sql`${guildStatsUserDaily.messages} > 0`,
      ),
    )
    .groupBy(guildStatsUserDaily.statDate);

  const byDate = new Map(rows.map((row) => [row.statDate, Number(row.count ?? 0)]));
  return dates.map((date) => ({ statDate: date, count: byDate.get(date) ?? 0 }));
}
