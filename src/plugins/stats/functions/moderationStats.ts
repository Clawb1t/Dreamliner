import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { automodHits, modCases } from "../../../db/schema.js";
import { dateRange, dateRangeInclusive, isAllTimeWindow, statDate } from "./daily.js";

/** `automod_hits` rows older than this are hard-pruned (see pruneOldAutomodHits in
 *  src/plugins/automod/functions/strikes.ts), so any "how far back" query over that table must stay
 *  within this bound, since older history genuinely doesn't exist anymore. Exported so the
 *  website payload can tell the frontend exactly what "all time" means for this metric. */
export const AUTOMOD_HIT_RETENTION_DAYS = 30;

function dayBoundary(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

export type ModCaseDailyRow = { statDate: string; total: number; byType: Record<string, number> };

function aggregateByDateAndType(rows: { statDate: string; type: string; count: number }[]) {
  const byDate = new Map<string, { total: number; byType: Record<string, number> }>();
  for (const row of rows) {
    const entry = byDate.get(row.statDate) ?? { total: 0, byType: {} };
    entry.total += row.count;
    entry.byType[row.type] = (entry.byType[row.type] ?? 0) + row.count;
    byDate.set(row.statDate, entry);
  }
  return byDate;
}

/** Zero-filled per-day mod case counts, with a per-type breakdown alongside the total. */
export async function getFilledModCaseDaily(guildId: string, days: number = 14): Promise<ModCaseDailyRow[]> {
  const db = getDb();

  const select = () =>
    db
      .select({
        statDate: sql<string>`date(${modCases.createdAt}, 'unixepoch')`,
        type: modCases.type,
        count: sql<number>`count(*)`,
      })
      .from(modCases);

  if (isAllTimeWindow(days)) {
    const rows = await select().where(eq(modCases.guildId, guildId)).groupBy(sql`date(${modCases.createdAt}, 'unixepoch')`, modCases.type);
    if (rows.length === 0) return [];
    const byDate = aggregateByDateAndType(rows);
    const earliest = [...byDate.keys()].sort()[0]!;
    const dates = dateRangeInclusive(earliest, statDate());
    return dates.map((date) => {
      const entry = byDate.get(date);
      return { statDate: date, total: entry?.total ?? 0, byType: entry?.byType ?? {} };
    });
  }

  const dates = dateRange(days);
  const since = dates[0]!;
  const rows = await select()
    .where(and(eq(modCases.guildId, guildId), gte(modCases.createdAt, dayBoundary(since))))
    .groupBy(sql`date(${modCases.createdAt}, 'unixepoch')`, modCases.type);
  const byDate = aggregateByDateAndType(rows);
  return dates.map((date) => {
    const entry = byDate.get(date);
    return { statDate: date, total: entry?.total ?? 0, byType: entry?.byType ?? {} };
  });
}

export type AutomodHitDailyRow = { statDate: string; hits: number };

/** Zero-filled per-day automod hit counts, bounded to the last 30 days regardless of the
 *  requested window (including "all time") since older rows are hard-pruned. */
export async function getFilledAutomodHitDaily(guildId: string, days: number = 14): Promise<AutomodHitDailyRow[]> {
  const db = getDb();
  const cappedDays = isAllTimeWindow(days) ? AUTOMOD_HIT_RETENTION_DAYS : Math.min(days, AUTOMOD_HIT_RETENTION_DAYS);

  const dates = dateRange(cappedDays);
  const since = dates[0]!;
  const rows = await db
    .select({
      statDate: sql<string>`date(${automodHits.createdAt}, 'unixepoch')`,
      count: sql<number>`count(*)`,
    })
    .from(automodHits)
    .where(and(eq(automodHits.guildId, guildId), gte(automodHits.createdAt, dayBoundary(since))))
    .groupBy(sql`date(${automodHits.createdAt}, 'unixepoch')`);

  const byDate = new Map(rows.map((row) => [row.statDate, row.count]));
  return dates.map((date) => ({ statDate: date, hits: byDate.get(date) ?? 0 }));
}

/** Top automod rules by hit count, bounded to the last 30 days (see getFilledAutomodHitDaily). */
export async function getTopAutomodRules(
  guildId: string,
  days: number = 14,
  limit = 5,
): Promise<{ ruleId: string; count: number }[]> {
  const db = getDb();
  const cappedDays = isAllTimeWindow(days) ? AUTOMOD_HIT_RETENTION_DAYS : Math.min(days, AUTOMOD_HIT_RETENTION_DAYS);
  const since = dateRange(cappedDays)[0]!;

  const rows = await db
    .select({ ruleId: automodHits.ruleId, count: sql<number>`count(*)` })
    .from(automodHits)
    .where(and(eq(automodHits.guildId, guildId), gte(automodHits.createdAt, dayBoundary(since))))
    .groupBy(automodHits.ruleId)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  return rows;
}

/** Mod case counts grouped by type over the window (or all time), for a pie-style breakdown. */
export async function getModCaseTypeBreakdown(
  guildId: string,
  days: number = 14,
): Promise<{ type: string; count: number }[]> {
  const db = getDb();
  const filters = [eq(modCases.guildId, guildId)];
  if (!isAllTimeWindow(days)) {
    const since = dateRange(days)[0]!;
    filters.push(gte(modCases.createdAt, dayBoundary(since)));
  }

  const rows = await db
    .select({ type: modCases.type, count: sql<number>`count(*)` })
    .from(modCases)
    .where(and(...filters))
    .groupBy(modCases.type)
    .orderBy(desc(sql`count(*)`));

  return rows;
}
