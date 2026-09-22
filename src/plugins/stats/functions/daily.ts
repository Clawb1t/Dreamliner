import { and, asc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import {
  guildStatsChannelDaily,
  guildStatsDaily,
  guildStatsHourly,
  guildStatsHourlyBucket,
  guildStatsUserDaily,
  userHourlyActivity,
} from "../../../db/schema.js";
import { recordUserTrail } from "../../../core/logging/userTrail.js";
import { defaultTranslator, type Translator } from "../../../i18n/index.js";

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

/** `1` means "today (UTC)" — a real 1-day window over the existing daily tables, not a true
 *  trailing-24h figure (that needs guildStatsHourlyBucket; see getLast24hBucketStats below).
 *  Labeled accordingly rather than as a misleading "24h". */
export const TODAY_WINDOW = 1;

export type StatsWindow = typeof TODAY_WINDOW | 7 | 14 | 30 | 90 | typeof ALL_TIME_WINDOW;

export function isAllTimeWindow(days: number): boolean {
  return days === ALL_TIME_WINDOW;
}

export function isValidStatsWindow(days: number): days is StatsWindow {
  return (
    days === TODAY_WINDOW || days === 7 || days === 14 || days === 30 || days === 90 || days === ALL_TIME_WINDOW
  );
}

export function formatStatsWindowLabel(days: StatsWindow, t: Translator = defaultTranslator): string {
  if (isAllTimeWindow(days)) return t("stats.windowLabelAllTime", "all time");
  if (days === TODAY_WINDOW) return t("stats.windowLabelToday", "today");
  return t("stats.windowLabelDays", "{days}d", { days });
}

export function formatStatsWindowLong(days: StatsWindow, t: Translator = defaultTranslator): string {
  if (isAllTimeWindow(days)) return t("stats.windowLongAllTime", "All time");
  if (days === TODAY_WINDOW) return t("stats.windowLongToday", "Today (UTC)");
  return t("stats.windowLongDays", "{days} days", { days });
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

/** The UTC-midnight `Date` boundary for `windowSince(days)`, for filtering a timestamp column
 *  (`integer("...", { mode: "timestamp" })`) by the same window a `statDate` text column would
 *  use. Null for the all-time window (no lower bound). */
export function windowSinceTimestamp(days: number): Date | null {
  const since = windowSince(days);
  return since ? new Date(`${since}T00:00:00.000Z`) : null;
}

/**
 * Resolves the zero-filled date list for a "filled" series query that (unlike the daily/user/
 * channel stats tables) has no guaranteed row for every day: for a fixed window this is just
 * `dateRange(days)`, but for the all-time window there's no fixed start, so it's derived from the
 * earliest date actually present in `candidateDates` (e.g. the union of several source tables'
 * distinct dates). Returns `[]` for the all-time window when nothing has ever been recorded.
 */
export function resolveFilledWindow(days: number, candidateDates: string[]): string[] {
  if (!isAllTimeWindow(days)) return dateRange(days);
  if (candidateDates.length === 0) return [];
  const earliest = [...candidateDates].sort()[0]!;
  return dateRangeInclusive(earliest, statDate());
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

/** Bumps the user's lifetime count for the current UTC hour-of-day, used for "active hours". */
export async function incrementUserHourlyStat(userId: string): Promise<void> {
  const db = getDb();
  const hourUtc = new Date().getUTCHours();
  await db
    .insert(userHourlyActivity)
    .values({ userId, hourUtc, count: 1 })
    .onConflictDoUpdate({
      target: [userHourlyActivity.userId, userHourlyActivity.hourUtc],
      set: { count: sql`${userHourlyActivity.count} + 1` },
    });
}

/** Bumps the guild's lifetime message count for the current UTC weekday x hour-of-day cell,
 *  used for the stats panel's hour x weekday activity heatmap. Separate from
 *  incrementUserHourlyStat above, which tracks a per-user/global hour-of-day metric. */
export async function incrementGuildHourlyStat(guildId: string): Promise<void> {
  const db = getDb();
  const now = new Date();
  const weekdayUtc = now.getUTCDay();
  const hourUtc = now.getUTCHours();
  await db
    .insert(guildStatsHourly)
    .values({ guildId, weekdayUtc, hourUtc, messages: 1 })
    .onConflictDoUpdate({
      target: [guildStatsHourly.guildId, guildStatsHourly.weekdayUtc, guildStatsHourly.hourUtc],
      set: { messages: sql`${guildStatsHourly.messages} + 1` },
    });
}

function bucketHour(d = new Date()): string {
  return d.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
}

/** UTC bucket-hour keys covering the trailing `hours` hours, oldest → newest, e.g. for summing the
 *  last 24 rows of guildStatsHourlyBucket into a true rolling window. */
export function hourBucketRange(hours: number, end = new Date()): string[] {
  const out: string[] = [];
  const endMs = end.getTime();
  for (let i = hours - 1; i >= 0; i--) {
    out.push(bucketHour(new Date(endMs - i * 3_600_000)));
  }
  return out;
}

type HourlyBucketField = DailyField;

const HOURLY_BUCKET_COLUMNS = {
  messages: guildStatsHourlyBucket.messages,
  joins: guildStatsHourlyBucket.joins,
  leaves: guildStatsHourlyBucket.leaves,
  edits: guildStatsHourlyBucket.edits,
  deletes: guildStatsHourlyBucket.deletes,
  reactions: guildStatsHourlyBucket.reactions,
  attachments: guildStatsHourlyBucket.attachments,
} as const;

/** Rolling-hour counterpart to incrementDailyStat, feeding guildStatsHourlyBucket so a true
 *  trailing-24h window (not just "today since 00:00 UTC") is queryable. Called at the same sites
 *  as incrementDailyStat, one new line alongside each existing call. */
export async function incrementHourlyBucketStat(
  guildId: string,
  field: HourlyBucketField,
  amount = 1,
): Promise<void> {
  const db = getDb();
  const hour = bucketHour();
  const base = {
    guildId,
    bucketHour: hour,
    messages: 0,
    joins: 0,
    leaves: 0,
    edits: 0,
    deletes: 0,
    reactions: 0,
    attachments: 0,
  };
  base[field] = amount;

  const column = HOURLY_BUCKET_COLUMNS[field];

  await db
    .insert(guildStatsHourlyBucket)
    .values(base)
    .onConflictDoUpdate({
      target: [guildStatsHourlyBucket.guildId, guildStatsHourlyBucket.bucketHour],
      set: { [field]: sql`${column} + ${amount}` },
    });
}

/** Best-effort prune of hourly-bucket rows older than 8 days — only the trailing ~24-48h is ever
 *  queried from this table, so it stays small regardless of guild age/size. */
export async function pruneOldHourlyBuckets(): Promise<void> {
  const cutoffHour = bucketHour(new Date(Date.now() - 8 * 86_400_000));
  await getDb().delete(guildStatsHourlyBucket).where(lt(guildStatsHourlyBucket.bucketHour, cutoffHour));
}

export type HourlyBucketTotals = {
  messages: number;
  joins: number;
  leaves: number;
  edits: number;
  deletes: number;
  reactions: number;
  attachments: number;
};

/** Sums guildStatsHourlyBucket rows across the trailing `hours` hours (default 24) — the actual
 *  rolling-window figure the daily tables can't provide (see TODAY_WINDOW's doc comment above). */
export async function getRollingHourlyTotals(guildId: string, hours = 24): Promise<HourlyBucketTotals> {
  const bucketHours = hourBucketRange(hours);
  const since = bucketHours[0]!;
  const rows = await getDb()
    .select()
    .from(guildStatsHourlyBucket)
    .where(and(eq(guildStatsHourlyBucket.guildId, guildId), gte(guildStatsHourlyBucket.bucketHour, since)));

  return rows.reduce<HourlyBucketTotals>(
    (acc, row) => ({
      messages: acc.messages + row.messages,
      joins: acc.joins + row.joins,
      leaves: acc.leaves + row.leaves,
      edits: acc.edits + row.edits,
      deletes: acc.deletes + row.deletes,
      reactions: acc.reactions + row.reactions,
      attachments: acc.attachments + row.attachments,
    }),
    { messages: 0, joins: 0, leaves: 0, edits: 0, deletes: 0, reactions: 0, attachments: 0 },
  );
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
    incrementUserHourlyStat(userId),
    incrementGuildHourlyStat(guildId),
    incrementHourlyBucketStat(guildId, "messages"),
    recordUserTrail(guildId, userId, channelId, content),
  ];
  if (attachmentCount > 0) {
    tasks.push(incrementDailyStat(guildId, "attachments", attachmentCount));
    tasks.push(incrementHourlyBucketStat(guildId, "attachments", attachmentCount));
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

/** Custom-range counterpart to getFilledDailyStats, for the `?from=&to=` query mode — same
 *  zero-filled-by-date contract, just bounded by an explicit inclusive date range instead of a
 *  trailing day count. */
export async function getFilledDailyStatsInRange(
  guildId: string,
  from: string,
  to: string,
): Promise<DailyStatRow[]> {
  const dates = dateRangeInclusive(from, to);
  if (dates.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select()
    .from(guildStatsDaily)
    .where(
      and(eq(guildStatsDaily.guildId, guildId), gte(guildStatsDaily.statDate, from), lte(guildStatsDaily.statDate, to)),
    );
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

/** Zero-filled 7 (weekday, UTC) x 24 (hour, UTC) message activity grid for a guild, always 168
 *  cells regardless of how many are actually populated. */
export async function getGuildHourlyHeatmap(
  guildId: string,
): Promise<{ weekday: number; hour: number; messages: number }[]> {
  const db = getDb();
  const rows = await db.select().from(guildStatsHourly).where(eq(guildStatsHourly.guildId, guildId));
  const byCell = new Map(rows.map((row) => [`${row.weekdayUtc}:${row.hourUtc}`, row.messages]));

  const grid: { weekday: number; hour: number; messages: number }[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      grid.push({ weekday, hour, messages: byCell.get(`${weekday}:${hour}`) ?? 0 });
    }
  }
  return grid;
}
