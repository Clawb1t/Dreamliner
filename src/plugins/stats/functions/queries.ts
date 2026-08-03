import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import {
  guildMessageCounts,
  guildStatsChannelDaily,
  guildStatsUserDaily,
  logMessages,
} from "../../../db/schema.js";
import { dateRange } from "./daily.js";

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
  const since = dateRange(days)[0]!;
  const rows = await db
    .select({
      channelId: guildStatsChannelDaily.channelId,
      count: sql<number>`coalesce(sum(${guildStatsChannelDaily.messages}), 0)`,
    })
    .from(guildStatsChannelDaily)
    .where(and(eq(guildStatsChannelDaily.guildId, guildId), gte(guildStatsChannelDaily.statDate, since)))
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
  const since = dateRange(days)[0]!;
  const rows = await db
    .select({
      userId: guildStatsUserDaily.userId,
      count: sql<number>`coalesce(sum(${guildStatsUserDaily.messages}), 0)`,
    })
    .from(guildStatsUserDaily)
    .where(and(eq(guildStatsUserDaily.guildId, guildId), gte(guildStatsUserDaily.statDate, since)))
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
  const since = dateRange(days)[0]!;
  const row = await db
    .select({ total: sql<number>`coalesce(sum(${guildStatsUserDaily.messages}), 0)` })
    .from(guildStatsUserDaily)
    .where(
      and(
        eq(guildStatsUserDaily.guildId, guildId),
        eq(guildStatsUserDaily.userId, userId),
        gte(guildStatsUserDaily.statDate, since),
      ),
    )
    .get();
  return Number(row?.total ?? 0);
}
