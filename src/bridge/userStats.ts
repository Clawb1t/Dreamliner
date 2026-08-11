import type { Client } from "discord.js";
import { and, count, desc, eq, gt, gte, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import {
  guildMessageCounts,
  guildStatsUserDaily,
  reminders,
  reviews,
  suggestionFollows,
  suggestionVotes,
  userMessageCounts,
} from "../db/schema.js";
import { dateRange, windowSince } from "../plugins/stats/functions/daily.js";

export type UserPersonalStats = {
  userId: string;
  totalMessages: number;
  globalRank: number | null;
  activeMessagers: number;
  serverCount: number;
  messagesLast14Days: number;
  reminders: number;
  reviews: number;
  suggestionVotes: number;
  suggestionFollows: number;
  daily: Array<{ date: string; messages: number }>;
  servers: Array<{
    id: string;
    name: string;
    icon: string | null;
    messages: number;
    rank: number | null;
    sharePct: number | null;
  }>;
};

async function guildRank(guildId: string, userCount: number): Promise<number | null> {
  if (userCount <= 0) return null;
  const higher = await getDb()
    .select({ total: count() })
    .from(guildMessageCounts)
    .where(
      and(eq(guildMessageCounts.guildId, guildId), gt(guildMessageCounts.count, userCount)),
    )
    .get();
  return Number(higher?.total ?? 0) + 1;
}

async function guildTrafficTotal(guildId: string): Promise<number> {
  const row = await getDb()
    .select({ total: sql<number>`coalesce(sum(${guildMessageCounts.count}), 0)` })
    .from(guildMessageCounts)
    .where(eq(guildMessageCounts.guildId, guildId))
    .get();
  return Number(row?.total ?? 0);
}

export async function buildUserPersonalStats(
  client: Client,
  userId: string,
): Promise<UserPersonalStats> {
  const db = getDb();

  const [globalRow, activeRow, guildRows, reminderCount, reviewCount, voteCount, followCount] =
    await Promise.all([
      db
        .select()
        .from(userMessageCounts)
        .where(eq(userMessageCounts.userId, userId))
        .get(),
      db
        .select({ total: count() })
        .from(userMessageCounts)
        .where(gte(userMessageCounts.count, 1))
        .get(),
      db
        .select()
        .from(guildMessageCounts)
        .where(eq(guildMessageCounts.userId, userId))
        .orderBy(desc(guildMessageCounts.count))
        .all(),
      db.select({ total: count() }).from(reminders).where(eq(reminders.userId, userId)).get(),
      db.select({ total: count() }).from(reviews).where(eq(reviews.userId, userId)).get(),
      db
        .select({ total: count() })
        .from(suggestionVotes)
        .where(eq(suggestionVotes.userId, userId))
        .get(),
      db
        .select({ total: count() })
        .from(suggestionFollows)
        .where(eq(suggestionFollows.userId, userId))
        .get(),
    ]);

  const totalMessages = Number(globalRow?.count ?? 0);
  const activeMessagers = Number(activeRow?.total ?? 0);

  let globalRank: number | null = null;
  if (totalMessages > 0) {
    const higher = await db
      .select({ total: count() })
      .from(userMessageCounts)
      .where(gt(userMessageCounts.count, totalMessages))
      .get();
    globalRank = Number(higher?.total ?? 0) + 1;
  }

  const since = windowSince(14);
  const dates = dateRange(14);
  const dailyRows = since
    ? await db
        .select({
          date: guildStatsUserDaily.statDate,
          messages: sql<number>`coalesce(sum(${guildStatsUserDaily.messages}), 0)`,
        })
        .from(guildStatsUserDaily)
        .where(
          and(eq(guildStatsUserDaily.userId, userId), gte(guildStatsUserDaily.statDate, since)),
        )
        .groupBy(guildStatsUserDaily.statDate)
        .all()
    : [];
  const dailyMap = new Map(dailyRows.map((row) => [row.date, Number(row.messages ?? 0)]));
  const daily = dates.map((date) => ({
    date,
    messages: dailyMap.get(date) ?? 0,
  }));
  const messagesLast14Days = daily.reduce((sum, row) => sum + row.messages, 0);

  const servers = await Promise.all(
    guildRows.slice(0, 50).map(async (row) => {
      const guild = client.guilds.cache.get(row.guildId);
      const [rank, traffic] = await Promise.all([
        guildRank(row.guildId, row.count),
        guildTrafficTotal(row.guildId),
      ]);
      return {
        id: row.guildId,
        name: guild?.name ?? "Unknown server",
        icon: guild?.iconURL({ size: 64 }) ?? null,
        messages: row.count,
        rank,
        sharePct: traffic > 0 ? Math.round((row.count / traffic) * 1000) / 10 : null,
      };
    }),
  );

  return {
    userId,
    totalMessages,
    globalRank,
    activeMessagers,
    serverCount: guildRows.length,
    messagesLast14Days,
    reminders: Number(reminderCount?.total ?? 0),
    reviews: Number(reviewCount?.total ?? 0),
    suggestionVotes: Number(voteCount?.total ?? 0),
    suggestionFollows: Number(followCount?.total ?? 0),
    daily,
    servers,
  };
}
