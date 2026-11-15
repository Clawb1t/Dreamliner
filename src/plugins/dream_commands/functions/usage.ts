import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { commandUsageDaily, commandUsageTotals } from "../../../db/schema.js";
import { dateRange } from "../../stats/functions/daily.js";

/**
 * Usage numbers for a server's custom commands, for the dashboard's command list. Read from the
 * same command_usage_* tables trackCommandUsage writes to (run.ts records every successful reply),
 * keyed by command name, so a command that was deleted and re-made with the same name keeps its
 * old count.
 */

export const USAGE_WINDOW_DAYS = 30;

export type DreamCommandUsage = {
  total: number;
  last7d: number;
  last30d: number;
  /** UTC date (YYYY-MM-DD) of the latest day with a use, or null when never used. */
  lastUsedDate: string | null;
};

export type DreamCommandsUsageSummary = {
  byName: Record<string, DreamCommandUsage>;
  total: number;
  last7d: number;
  last30d: number;
  /** Uses of all these commands per UTC day, oldest first, `USAGE_WINDOW_DAYS` long. */
  daily: Array<{ date: string; uses: number }>;
};

type DailyRow = { commandName: string; statDate: string; uses: number };
type TotalRow = { commandName: string; uses: number };

/** Pure: folds the raw rows into per-command and overall numbers. `dates` is the 30-day window. */
export function summarizeDreamCommandUsage(
  names: readonly string[],
  totals: readonly TotalRow[],
  daily: readonly DailyRow[],
  dates: readonly string[],
): DreamCommandsUsageSummary {
  const wanted = new Set(names);
  const since7 = dates[Math.max(0, dates.length - 7)] ?? "";
  const byName: Record<string, DreamCommandUsage> = {};
  for (const name of names) byName[name] = { total: 0, last7d: 0, last30d: 0, lastUsedDate: null };

  for (const row of totals) {
    const entry = byName[row.commandName];
    if (entry) entry.total = Number(row.uses) || 0;
  }

  const perDay = new Map<string, number>(dates.map((date) => [date, 0]));
  for (const row of daily) {
    if (!wanted.has(row.commandName)) continue;
    const uses = Number(row.uses) || 0;
    if (uses <= 0) continue;
    const entry = byName[row.commandName]!;
    if (perDay.has(row.statDate)) {
      perDay.set(row.statDate, perDay.get(row.statDate)! + uses);
      entry.last30d += uses;
      if (row.statDate >= since7) entry.last7d += uses;
    }
    if (!entry.lastUsedDate || row.statDate > entry.lastUsedDate) entry.lastUsedDate = row.statDate;
  }

  const all = Object.values(byName);
  return {
    byName,
    total: all.reduce((sum, u) => sum + u.total, 0),
    last7d: all.reduce((sum, u) => sum + u.last7d, 0),
    last30d: all.reduce((sum, u) => sum + u.last30d, 0),
    daily: dates.map((date) => ({ date, uses: perDay.get(date) ?? 0 })),
  };
}

export async function getDreamCommandsUsage(guildId: string, names: readonly string[]): Promise<DreamCommandsUsageSummary> {
  const dates = dateRange(USAGE_WINDOW_DAYS);
  if (names.length === 0) return summarizeDreamCommandUsage([], [], [], dates);
  const db = getDb();
  const list = [...names];
  const [totals, daily] = await Promise.all([
    db
      .select({ commandName: commandUsageTotals.commandName, uses: commandUsageTotals.uses })
      .from(commandUsageTotals)
      .where(and(eq(commandUsageTotals.guildId, guildId), inArray(commandUsageTotals.commandName, list))),
    // Every day ever for these names (at most 10 commands, one row per command per day used), so the
    // "last used" date is right even for a command nobody has run in the last 30 days.
    db
      .select({
        commandName: commandUsageDaily.commandName,
        statDate: commandUsageDaily.statDate,
        uses: commandUsageDaily.uses,
      })
      .from(commandUsageDaily)
      .where(and(eq(commandUsageDaily.guildId, guildId), inArray(commandUsageDaily.commandName, list))),
  ]);
  return summarizeDreamCommandUsage(names, totals, daily, dates);
}
