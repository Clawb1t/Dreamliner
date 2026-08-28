import { and, asc, count, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import {
  guildStatsChannelDaily,
  guildStatsDaily,
  guildStatsUserDaily,
  userMessageCounts,
} from "../../../db/schema.js";
import {
  dateRange,
  dateRangeInclusive,
  isAllTimeWindow,
  statDate,
  windowSince,
  type DailyStatRow,
} from "./daily.js";

function emptyDailyRow(date: string): DailyStatRow {
  return {
    statDate: date,
    messages: 0,
    joins: 0,
    leaves: 0,
    edits: 0,
    deletes: 0,
    reactions: 0,
    attachments: 0,
  };
}

function fillDailyDates(dates: string[], rows: DailyStatRow[]): DailyStatRow[] {
  const byDate = new Map(rows.map((row) => [row.statDate, row]));
  return dates.map((date) => byDate.get(date) ?? emptyDailyRow(date));
}

/** Sum of lifetime global user message counters. */
export async function getGlobalTrackedMessagesTotal(): Promise<number> {
  const db = getDb();
  const row = await db
    .select({ total: sql<number>`coalesce(sum(${userMessageCounts.count}), 0)` })
    .from(userMessageCounts)
    .get();
  return Number(row?.total ?? 0);
}

export async function getGlobalActiveMessagerCount(): Promise<number> {
  const db = getDb();
  const row = await db
    .select({ total: count() })
    .from(userMessageCounts)
    .where(gte(userMessageCounts.count, 1))
    .get();
  return Number(row?.total ?? 0);
}

/** Lifetime global message count for a single user. */
export async function getGlobalUserMessageCount(userId: string): Promise<number> {
  const db = getDb();
  const row = await db
    .select({ count: userMessageCounts.count })
    .from(userMessageCounts)
    .where(eq(userMessageCounts.userId, userId))
    .get();
  return row?.count ?? 0;
}

/** 1-based global rank of a user by lifetime message count (1 = most messages). */
export async function getGlobalUserMessageRank(userCount: number): Promise<number> {
  if (userCount <= 0) return 0;
  const db = getDb();
  const row = await db
    .select({ total: count() })
    .from(userMessageCounts)
    .where(sql`${userMessageCounts.count} > ${userCount}`)
    .get();
  return (row?.total ?? 0) + 1;
}

export async function getTopGlobalMessagers(
  limit = 25,
): Promise<Array<{ userId: string; count: number }>> {
  const db = getDb();
  const rows = await db
    .select()
    .from(userMessageCounts)
    .orderBy(desc(userMessageCounts.count))
    .limit(limit);
  return rows.map((row) => ({ userId: row.userId, count: row.count }));
}

export async function getGlobalDailyTotals(): Promise<{
  messages: number;
  joins: number;
  leaves: number;
  edits: number;
  deletes: number;
  reactions: number;
  attachments: number;
}> {
  const db = getDb();
  const row = await db
    .select({
      messages: sql<number>`coalesce(sum(${guildStatsDaily.messages}), 0)`,
      joins: sql<number>`coalesce(sum(${guildStatsDaily.joins}), 0)`,
      leaves: sql<number>`coalesce(sum(${guildStatsDaily.leaves}), 0)`,
      edits: sql<number>`coalesce(sum(${guildStatsDaily.edits}), 0)`,
      deletes: sql<number>`coalesce(sum(${guildStatsDaily.deletes}), 0)`,
      reactions: sql<number>`coalesce(sum(${guildStatsDaily.reactions}), 0)`,
      attachments: sql<number>`coalesce(sum(${guildStatsDaily.attachments}), 0)`,
    })
    .from(guildStatsDaily)
    .get();

  return {
    messages: Number(row?.messages ?? 0),
    joins: Number(row?.joins ?? 0),
    leaves: Number(row?.leaves ?? 0),
    edits: Number(row?.edits ?? 0),
    deletes: Number(row?.deletes ?? 0),
    reactions: Number(row?.reactions ?? 0),
    attachments: Number(row?.attachments ?? 0),
  };
}

export async function getFilledGlobalDailyStats(days = 14): Promise<DailyStatRow[]> {
  const db = getDb();

  if (isAllTimeWindow(days)) {
    const rows = await db
      .select({
        statDate: guildStatsDaily.statDate,
        messages: sql<number>`coalesce(sum(${guildStatsDaily.messages}), 0)`,
        joins: sql<number>`coalesce(sum(${guildStatsDaily.joins}), 0)`,
        leaves: sql<number>`coalesce(sum(${guildStatsDaily.leaves}), 0)`,
        edits: sql<number>`coalesce(sum(${guildStatsDaily.edits}), 0)`,
        deletes: sql<number>`coalesce(sum(${guildStatsDaily.deletes}), 0)`,
        reactions: sql<number>`coalesce(sum(${guildStatsDaily.reactions}), 0)`,
        attachments: sql<number>`coalesce(sum(${guildStatsDaily.attachments}), 0)`,
      })
      .from(guildStatsDaily)
      .groupBy(guildStatsDaily.statDate)
      .orderBy(asc(guildStatsDaily.statDate));
    if (rows.length === 0) return [];
    const mapped = rows.map((row) => ({
      statDate: row.statDate,
      messages: Number(row.messages ?? 0),
      joins: Number(row.joins ?? 0),
      leaves: Number(row.leaves ?? 0),
      edits: Number(row.edits ?? 0),
      deletes: Number(row.deletes ?? 0),
      reactions: Number(row.reactions ?? 0),
      attachments: Number(row.attachments ?? 0),
    }));
    return fillDailyDates(dateRangeInclusive(mapped[0]!.statDate, statDate()), mapped);
  }

  const dates = dateRange(days);
  const since = dates[0]!;
  const rows = await db
    .select({
      statDate: guildStatsDaily.statDate,
      messages: sql<number>`coalesce(sum(${guildStatsDaily.messages}), 0)`,
      joins: sql<number>`coalesce(sum(${guildStatsDaily.joins}), 0)`,
      leaves: sql<number>`coalesce(sum(${guildStatsDaily.leaves}), 0)`,
      edits: sql<number>`coalesce(sum(${guildStatsDaily.edits}), 0)`,
      deletes: sql<number>`coalesce(sum(${guildStatsDaily.deletes}), 0)`,
      reactions: sql<number>`coalesce(sum(${guildStatsDaily.reactions}), 0)`,
      attachments: sql<number>`coalesce(sum(${guildStatsDaily.attachments}), 0)`,
    })
    .from(guildStatsDaily)
    .where(gte(guildStatsDaily.statDate, since))
    .groupBy(guildStatsDaily.statDate);

  const mapped = rows.map((row) => ({
    statDate: row.statDate,
    messages: Number(row.messages ?? 0),
    joins: Number(row.joins ?? 0),
    leaves: Number(row.leaves ?? 0),
    edits: Number(row.edits ?? 0),
    deletes: Number(row.deletes ?? 0),
    reactions: Number(row.reactions ?? 0),
    attachments: Number(row.attachments ?? 0),
  }));
  return fillDailyDates(dates, mapped);
}

export async function getTopGlobalUsersByDaily(
  days = 14,
  limit = 15,
): Promise<Array<{ userId: string; count: number }>> {
  if (isAllTimeWindow(days)) {
    return getTopGlobalMessagers(limit);
  }

  const db = getDb();
  const since = windowSince(days);
  const query = db
    .select({
      userId: guildStatsUserDaily.userId,
      count: sql<number>`coalesce(sum(${guildStatsUserDaily.messages}), 0)`,
    })
    .from(guildStatsUserDaily);

  const rows = await (since
    ? query.where(gte(guildStatsUserDaily.statDate, since))
    : query
  )
    .groupBy(guildStatsUserDaily.userId)
    .orderBy(desc(sql`coalesce(sum(${guildStatsUserDaily.messages}), 0)`))
    .limit(limit);

  return rows.map((row) => ({ userId: row.userId, count: Number(row.count ?? 0) }));
}

export async function getTopGlobalChannelsByDaily(
  days = 14,
  limit = 15,
): Promise<Array<{ channelId: string; guildId: string; count: number }>> {
  const db = getDb();
  const since = windowSince(days);
  const query = db
    .select({
      channelId: guildStatsChannelDaily.channelId,
      guildId: guildStatsChannelDaily.guildId,
      count: sql<number>`coalesce(sum(${guildStatsChannelDaily.messages}), 0)`,
    })
    .from(guildStatsChannelDaily);

  const rows = await (since
    ? query.where(gte(guildStatsChannelDaily.statDate, since))
    : query
  )
    .groupBy(guildStatsChannelDaily.channelId, guildStatsChannelDaily.guildId)
    .orderBy(desc(sql`coalesce(sum(${guildStatsChannelDaily.messages}), 0)`))
    .limit(limit);

  return rows.map((row) => ({
    channelId: row.channelId,
    guildId: row.guildId,
    count: Number(row.count ?? 0),
  }));
}

export async function getFilledGlobalDailyActiveUsers(
  days = 14,
): Promise<Array<{ statDate: string; count: number }>> {
  const db = getDb();

  if (isAllTimeWindow(days)) {
    const rows = await db
      .select({
        statDate: guildStatsUserDaily.statDate,
        count: sql<number>`count(distinct ${guildStatsUserDaily.userId})`,
      })
      .from(guildStatsUserDaily)
      .where(sql`${guildStatsUserDaily.messages} > 0`)
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
    .where(and(gte(guildStatsUserDaily.statDate, since), sql`${guildStatsUserDaily.messages} > 0`))
    .groupBy(guildStatsUserDaily.statDate);

  const byDate = new Map(rows.map((row) => [row.statDate, Number(row.count ?? 0)]));
  return dates.map((date) => ({ statDate: date, count: byDate.get(date) ?? 0 }));
}

export async function getTrackedGlobalDailyMessagesTotal(days: number): Promise<number> {
  if (isAllTimeWindow(days)) {
    const totals = await getGlobalDailyTotals();
    return totals.messages;
  }
  const daily = await getFilledGlobalDailyStats(days);
  return daily.reduce((sum, row) => sum + row.messages, 0);
}

export async function getTrackedGlobalMessagesTotal(days: number): Promise<number> {
  if (isAllTimeWindow(days)) {
    return getGlobalTrackedMessagesTotal();
  }
  return getTrackedGlobalDailyMessagesTotal(days);
}
