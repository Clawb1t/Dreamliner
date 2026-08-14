import { and, asc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { guildStatsChannelDaily, guildStatsDaily, guildStatsUserDaily } from "../../../db/schema.js";
import { recordUserTrail } from "../../../core/logging/userTrail.js";

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

/** Use `0` in menus/state to mean every recorded day since tracking began. */
export const ALL_TIME_WINDOW = 0;

export type StatsWindow = 7 | 14 | 30 | typeof ALL_TIME_WINDOW;

export function isAllTimeWindow(days: number): boolean {
  return days === ALL_TIME_WINDOW;
}

export function isValidStatsWindow(days: number): days is StatsWindow {
  return days === 7 || days === 14 || days === 30 || days === ALL_TIME_WINDOW;
}

export function formatStatsWindowLabel(days: StatsWindow): string {
  if (isAllTimeWindow(days)) return "all time";
  return `${days}d`;
}

export function formatStatsWindowLong(days: StatsWindow): string {
  if (isAllTimeWindow(days)) return "All time";
  return `${days} days`;
}

export function windowSince(days: number): string | null {
  if (isAllTimeWindow(days)) return null;
  return dateRange(days)[0]!;
}

/** UTC dates from `start` through `end` inclusive. */
export function dateRangeInclusive(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = Date.parse(`${start}T12:00:00Z`);
  const endMs = Date.parse(`${end}T12:00:00Z`);
  while (cur <= endMs) {
    out.push(new Date(cur).toISOString().slice(0, 10));
    cur += 86_400_000;
  }
  return out;
}

function mapDailyRow(row: {
  statDate: string;
  messages: number;
  joins: number;
  leaves: number;
  edits?: number | null;
  deletes?: number | null;
  reactions?: number | null;
  attachments?: number | null;
}): DailyStatRow {
  return {
    statDate: row.statDate,
    messages: row.messages,
    joins: row.joins,
    leaves: row.leaves,
    edits: row.edits ?? 0,
    deletes: row.deletes ?? 0,
    reactions: row.reactions ?? 0,
    attachments: row.attachments ?? 0,
  };
}

function fillDailyDates<T extends DailyStatRow>(
  dates: string[],
  rows: T[],
  empty: (date: string) => T,
): T[] {
  const byDate = new Map(rows.map((row) => [row.statDate, row]));
  return dates.map((date) => byDate.get(date) ?? empty(date));
}

type DailyField = "messages" | "joins" | "leaves" | "edits" | "deletes" | "reactions" | "attachments";

const DAILY_COLUMNS = {
  messages: guildStatsDaily.messages,
  joins: guildStatsDaily.joins,
  leaves: guildStatsDaily.leaves,
  edits: guildStatsDaily.edits,
  deletes: guildStatsDaily.deletes,
  reactions: guildStatsDaily.reactions,
  attachments: guildStatsDaily.attachments,
} as const;

export async function incrementDailyStat(guildId: string, field: DailyField, amount = 1): Promise<void> {
  const db = getDb();
  const date = statDate();
  const base = {
    guildId,
    statDate: date,
    messages: 0,
    joins: 0,
    leaves: 0,
    edits: 0,
    deletes: 0,
    reactions: 0,
    attachments: 0,
  };
  base[field] = amount;

  const column = DAILY_COLUMNS[field];

  await db
    .insert(guildStatsDaily)
    .values(base)
    .onConflictDoUpdate({
      target: [guildStatsDaily.guildId, guildStatsDaily.statDate],
      set: { [field]: sql`${column} + ${amount}` },
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

export async function recordMessageActivity(
  guildId: string,
  userId: string,
  channelId: string,
  attachmentCount = 0,
  content?: string | null,
): Promise<void> {
  const tasks: Promise<void>[] = [
    incrementDailyStat(guildId, "messages"),
    incrementUserDailyStat(guildId, userId),
    incrementChannelDailyStat(guildId, channelId),
    recordUserTrail(guildId, userId, channelId, content),
  ];
  if (attachmentCount > 0) {
    tasks.push(incrementDailyStat(guildId, "attachments", attachmentCount));
  }
  await Promise.all(tasks);
}

export type DailyStatRow = {
  statDate: string;
  messages: number;
  joins: number;
  leaves: number;
  edits: number;
  deletes: number;
  reactions: number;
  attachments: number;
};

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

export async function getFilledDailyStats(guildId: string, days: number = 14): Promise<DailyStatRow[]> {
  const db = getDb();

  if (isAllTimeWindow(days)) {
    const rows = await db
      .select()
      .from(guildStatsDaily)
      .where(eq(guildStatsDaily.guildId, guildId))
      .orderBy(asc(guildStatsDaily.statDate));
    if (rows.length === 0) return [];
    const dates = dateRangeInclusive(rows[0]!.statDate, statDate());
    return fillDailyDates(dates, rows.map(mapDailyRow), emptyDailyRow);
  }

  const dates = dateRange(days);
  const since = dates[0]!;
  const rows = await db
    .select()
    .from(guildStatsDaily)
    .where(and(eq(guildStatsDaily.guildId, guildId), gte(guildStatsDaily.statDate, since)));

  return fillDailyDates(dates, rows.map(mapDailyRow), emptyDailyRow);
}

/** @deprecated Prefer getFilledDailyStats for chart continuity */
export async function getRecentDailyStats(guildId: string, days = 7): Promise<DailyStatRow[]> {
  const filled = await getFilledDailyStats(guildId, days);
  return [...filled].reverse();
}

export async function getDailyTotals(guildId: string): Promise<{
  messages: number;
  joins: number;
  leaves: number;
  edits: number;
  deletes: number;
  reactions: number;
  attachments: number;
}> {
  const db = getDb();
  const rows = await db.select().from(guildStatsDaily).where(eq(guildStatsDaily.guildId, guildId));
  return rows.reduce(
    (acc, row) => ({
      messages: acc.messages + row.messages,
      joins: acc.joins + row.joins,
      leaves: acc.leaves + row.leaves,
      edits: acc.edits + (row.edits ?? 0),
      deletes: acc.deletes + (row.deletes ?? 0),
      reactions: acc.reactions + (row.reactions ?? 0),
      attachments: acc.attachments + (row.attachments ?? 0),
    }),
    { messages: 0, joins: 0, leaves: 0, edits: 0, deletes: 0, reactions: 0, attachments: 0 },
  );
}

export async function getFilledUserDailyStats(
  guildId: string,
  userId: string,
  days: number = 14,
): Promise<{ statDate: string; messages: number }[]> {
  const db = getDb();

  if (isAllTimeWindow(days)) {
    const rows = await db
      .select()
      .from(guildStatsUserDaily)
      .where(and(eq(guildStatsUserDaily.guildId, guildId), eq(guildStatsUserDaily.userId, userId)))
      .orderBy(asc(guildStatsUserDaily.statDate));
    if (rows.length === 0) return [];
    const dates = dateRangeInclusive(rows[0]!.statDate, statDate());
    const byDate = new Map(rows.map((row) => [row.statDate, row.messages]));
    return dates.map((date) => ({ statDate: date, messages: byDate.get(date) ?? 0 }));
  }

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
  days: number = 14,
): Promise<{ statDate: string; messages: number }[]> {
  const db = getDb();

  if (isAllTimeWindow(days)) {
    const rows = await db
      .select()
      .from(guildStatsChannelDaily)
      .where(and(eq(guildStatsChannelDaily.guildId, guildId), eq(guildStatsChannelDaily.channelId, channelId)))
      .orderBy(asc(guildStatsChannelDaily.statDate));
    if (rows.length === 0) return [];
    const dates = dateRangeInclusive(rows[0]!.statDate, statDate());
    const byDate = new Map(rows.map((row) => [row.statDate, row.messages]));
    return dates.map((date) => ({ statDate: date, messages: byDate.get(date) ?? 0 }));
  }

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
