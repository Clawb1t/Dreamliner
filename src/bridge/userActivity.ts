import type { Client } from "discord.js";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { guildMessageCounts, guildStatsUserDaily, userHourlyActivity } from "../db/schema.js";
import { dateRange, windowSince } from "../plugins/stats/functions/daily.js";

/** Last `days` days of message activity, summed across every server, oldest → newest. */
export async function getUserDailyActivity(
  userId: string,
  days: number,
): Promise<Array<{ date: string; messages: number }>> {
  const since = windowSince(days);
  const dates = dateRange(days);
  if (!since) return dates.map((date) => ({ date, messages: 0 }));

  const rows = await getDb()
    .select({
      date: guildStatsUserDaily.statDate,
      messages: sql<number>`coalesce(sum(${guildStatsUserDaily.messages}), 0)`,
    })
    .from(guildStatsUserDaily)
    .where(and(eq(guildStatsUserDaily.userId, userId), gte(guildStatsUserDaily.statDate, since)))
    .groupBy(guildStatsUserDaily.statDate)
    .all();

  const map = new Map(rows.map((row) => [row.date, Number(row.messages ?? 0)]));
  return dates.map((date) => ({ date, messages: map.get(date) ?? 0 }));
}

/** Lifetime message count per UTC hour-of-day (0-23), for "active hours". */
export async function getUserHourlyActivity(userId: string): Promise<number[]> {
  const rows = await getDb()
    .select()
    .from(userHourlyActivity)
    .where(eq(userHourlyActivity.userId, userId))
    .all();
  const hours = new Array(24).fill(0) as number[];
  for (const row of rows) {
    if (row.hourUtc >= 0 && row.hourUtc < 24) hours[row.hourUtc] = row.count;
  }
  return hours;
}

export type UserGuildSummary = {
  id: string;
  name: string;
  icon: string | null;
  messages: number;
};

/** Servers this user has messaged in that the bot is currently also in, most active first. */
export async function listUserGuildSummaries(
  client: Client,
  userId: string,
  limit = 12,
): Promise<UserGuildSummary[]> {
  const rows = await getDb()
    .select()
    .from(guildMessageCounts)
    .where(eq(guildMessageCounts.userId, userId))
    .all();

  const summaries: UserGuildSummary[] = [];
  for (const row of rows) {
    const guild = client.guilds.cache.get(row.guildId);
    if (!guild) continue;
    summaries.push({
      id: row.guildId,
      name: guild.name,
      icon: guild.iconURL({ size: 64 }),
      messages: row.count,
    });
  }
  return summaries.sort((a, b) => b.messages - a.messages).slice(0, limit);
}
