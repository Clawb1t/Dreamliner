import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { incidentSignals } from "../../../db/schema.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { dateRange, dateRangeInclusive, isAllTimeWindow, statDate } from "./daily.js";

function dayBoundary(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

export type IncidentSignalDailyRow = { statDate: string; count: number };

/**
 * Zero-filled per-day incident-signal counts (incidentSignals has no prune job — unlike
 * automod_hits — so this can genuinely go back as far as requested/all-time). Returns null,
 * distinct from an empty/zero series, when the guild doesn't have Incident Response enabled — a
 * disabled plugin means "no data was ever collected here", not "zero incidents happened", and
 * callers must not conflate the two into a fabricated all-clear.
 */
export async function getFilledIncidentSignalDaily(guildId: string, days: number = 14): Promise<IncidentSignalDailyRow[] | null> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  if (!pluginEnabled(guildConfig, "incident_response")) return null;

  const db = getDb();
  const select = () =>
    db
      .select({
        statDate: sql<string>`date(${incidentSignals.createdAt}, 'unixepoch')`,
        count: sql<number>`count(*)`,
      })
      .from(incidentSignals);

  if (isAllTimeWindow(days)) {
    const rows = await select().where(eq(incidentSignals.guildId, guildId)).groupBy(sql`date(${incidentSignals.createdAt}, 'unixepoch')`);
    if (rows.length === 0) return [];
    const byDate = new Map(rows.map((row) => [row.statDate, row.count]));
    const earliest = [...byDate.keys()].sort()[0]!;
    const dates = dateRangeInclusive(earliest, statDate());
    return dates.map((date) => ({ statDate: date, count: byDate.get(date) ?? 0 }));
  }

  const dates = dateRange(days);
  const since = dates[0]!;
  const rows = await select()
    .where(and(eq(incidentSignals.guildId, guildId), gte(incidentSignals.createdAt, dayBoundary(since))))
    .groupBy(sql`date(${incidentSignals.createdAt}, 'unixepoch')`);
  const byDate = new Map(rows.map((row) => [row.statDate, row.count]));
  return dates.map((date) => ({ statDate: date, count: byDate.get(date) ?? 0 }));
}
