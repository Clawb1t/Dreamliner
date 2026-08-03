import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { guildStatsChannelDaily, guildStatsDaily, guildStatsUserDaily } from "../../../db/schema.js";

export function statDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** UTC calendar dates covering the last `days` days, oldest → newest. */
export function dateRange(days: number, end = new Date()): string[] {
  const out: string[] = [];
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(endUtc - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

export function shortDateLabel(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${Number(month)}/${Number(day)}`;
}

type DailyField = "messages" | "joins" | "leaves";

export async function incrementDailyStat(guildId: string, field: DailyField): Promise<void> {
  const db = getDb();
  const date = statDate();
  const base = { guildId, statDate: date, messages: 0, joins: 0, leaves: 0 };
  base[field] = 1;

  const column =
    field === "messages" ? guildStatsDaily.messages : field === "joins" ? guildStatsDaily.joins : guildStatsDaily.leaves;

  await db
    .insert(guildStatsDaily)
    .values(base)
    .onConflictDoUpdate({
      target: [guildStatsDaily.guildId, guildStatsDaily.statDate],
      set: { [field]: sql`${column} + 1` },
    });
}

export async function incrementUserDailyStat(guildId: string, userId: string): Promise<void> {
  const db = getDb();
  const date = statDate();
  await db
    .insert(guildStatsUserDaily)
    .values({ guildId, userId, statDate: date, messages: 1 })
    .onConflictDoUpdate({
      target: [guildStatsUserDaily.guildId, guildStatsUserDaily.userId, guildStatsUserDaily.statDate],
      set: { messages: sql`${guildStatsUserDaily.messages} + 1` },
    });
}

export async function incrementChannelDailyStat(guildId: string, channelId: string): Promise<void> {
  const db = getDb();
  const date = statDate();
  await db
    .insert(guildStatsChannelDaily)
    .values({ guildId, channelId, statDate: date, messages: 1 })
    .onConflictDoUpdate({
      target: [guildStatsChannelDaily.guildId, guildStatsChannelDaily.channelId, guildStatsChannelDaily.statDate],
      set: { messages: sql`${guildStatsChannelDaily.messages} + 1` },
    });
}

export async function recordMessageActivity(guildId: string, userId: string, channelId: string): Promise<void> {
  await Promise.all([
    incrementDailyStat(guildId, "messages"),
    incrementUserDailyStat(guildId, userId),
    incrementChannelDailyStat(guildId, channelId),
  ]);
}

export type DailyStatRow = {
  statDate: string;
  messages: number;
  joins: number;
  leaves: number;
};

export async function getFilledDailyStats(guildId: string, days = 14): Promise<DailyStatRow[]> {
  const db = getDb();
  const dates = dateRange(days);
  const since = dates[0]!;
  const rows = await db
    .select()
    .from(guildStatsDaily)
    .where(and(eq(guildStatsDaily.guildId, guildId), gte(guildStatsDaily.statDate, since)));

  const byDate = new Map(rows.map((row) => [row.statDate, row]));
  return dates.map((date) => {
    const row = byDate.get(date);
    return {
      statDate: date,
      messages: row?.messages ?? 0,
      joins: row?.joins ?? 0,
      leaves: row?.leaves ?? 0,
    };
  });
}

/** @deprecated Prefer getFilledDailyStats for chart continuity */
export async function getRecentDailyStats(guildId: string, days = 7): Promise<DailyStatRow[]> {
  const filled = await getFilledDailyStats(guildId, days);
  return [...filled].reverse();
}

export async function getDailyTotals(guildId: string): Promise<{ messages: number; joins: number; leaves: number }> {
  const db = getDb();
  const rows = await db.select().from(guildStatsDaily).where(eq(guildStatsDaily.guildId, guildId));
  return rows.reduce(
    (acc, row) => ({
      messages: acc.messages + row.messages,
      joins: acc.joins + row.joins,
      leaves: acc.leaves + row.leaves,
    }),
    { messages: 0, joins: 0, leaves: 0 },
  );
}

export async function getFilledUserDailyStats(guildId: string, userId: string, days = 14): Promise<{ statDate: string; messages: number }[]> {
  const db = getDb();
  const dates = dateRange(days);
  const since = dates[0]!;
  const rows = await db
    .select()
    .from(guildStatsUserDaily)
    .where(
      and(
        eq(guildStatsUserDaily.guildId, guildId),
        eq(guildStatsUserDaily.userId, userId),
        gte(guildStatsUserDaily.statDate, since),
      ),
    );

  const byDate = new Map(rows.map((row) => [row.statDate, row.messages]));
  return dates.map((date) => ({ statDate: date, messages: byDate.get(date) ?? 0 }));
}

export async function getFilledChannelDailyStats(
  guildId: string,
  channelId: string,
  days = 14,
): Promise<{ statDate: string; messages: number }[]> {
  const db = getDb();
  const dates = dateRange(days);
  const since = dates[0]!;
  const rows = await db
    .select()
    .from(guildStatsChannelDaily)
    .where(
      and(
        eq(guildStatsChannelDaily.guildId, guildId),
        eq(guildStatsChannelDaily.channelId, channelId),
        gte(guildStatsChannelDaily.statDate, since),
      ),
    );

  const byDate = new Map(rows.map((row) => [row.statDate, row.messages]));
  return dates.map((date) => ({ statDate: date, messages: byDate.get(date) ?? 0 }));
}
