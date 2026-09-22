import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { guildStatsUserDaily } from "../../../db/schema.js";
import { dateRange, isAllTimeWindow } from "./daily.js";

export type EngagementConcentration = {
  activeUserCount: number;
  topDecileSharePct: number;
  baselineActiveUserCount: number;
  baselineTopDecileSharePct: number;
  /** Percentage-point shift (not relative %) — this is a share-of-traffic comparison, not a
   *  volume one, so it's reported the same way engagement-rate deltas are. */
  deltaPct: number;
};

async function sumMessagesByUser(
  guildId: string,
  sinceDate: string,
  untilDateExclusive: string | null,
): Promise<Map<string, number>> {
  const conditions = [eq(guildStatsUserDaily.guildId, guildId), gte(guildStatsUserDaily.statDate, sinceDate)];
  if (untilDateExclusive) conditions.push(lt(guildStatsUserDaily.statDate, untilDateExclusive));

  const rows = await getDb()
    .select({
      userId: guildStatsUserDaily.userId,
      total: sql<number>`sum(${guildStatsUserDaily.messages})`,
    })
    .from(guildStatsUserDaily)
    .where(and(...conditions))
    .groupBy(guildStatsUserDaily.userId);

  return new Map(rows.map((row) => [row.userId, Number(row.total)]));
}

function topDecileShare(totalsByUser: Map<string, number>): { activeUserCount: number; sharePct: number } {
  const totals = [...totalsByUser.values()].sort((a, b) => b - a);
  const total = totals.reduce((sum, v) => sum + v, 0);
  if (totals.length === 0 || total === 0) return { activeUserCount: totals.length, sharePct: 0 };
  const decileCount = Math.max(1, Math.ceil(totals.length * 0.1));
  const topSum = totals.slice(0, decileCount).reduce((sum, v) => sum + v, 0);
  return { activeUserCount: totals.length, sharePct: (topSum / total) * 100 };
}

/**
 * What share of the guild's messages the most active 10% of posters account for, current window
 * vs. a trailing baseline — "is activity becoming more concentrated among fewer members". Both
 * windows computed with SQL-side GROUP BY (never a per-user-per-day pull into JS). Returns null
 * when there's no active-user data for the current window at all.
 */
export async function getEngagementConcentration(guildId: string, days: number): Promise<EngagementConcentration | null> {
  const compareWindowDays = isAllTimeWindow(days) ? 30 : days;
  const baselineHorizonDays = Math.max(28, compareWindowDays * 4);
  const currentSince = dateRange(compareWindowDays)[0]!;
  const baselineSince = dateRange(compareWindowDays + baselineHorizonDays)[0]!;

  const [currentByUser, baselineByUser] = await Promise.all([
    sumMessagesByUser(guildId, currentSince, null),
    sumMessagesByUser(guildId, baselineSince, currentSince),
  ]);

  const current = topDecileShare(currentByUser);
  if (current.activeUserCount === 0) return null;
  const baseline = topDecileShare(baselineByUser);

  return {
    activeUserCount: current.activeUserCount,
    topDecileSharePct: Number(current.sharePct.toFixed(1)),
    baselineActiveUserCount: baseline.activeUserCount,
    baselineTopDecileSharePct: Number(baseline.sharePct.toFixed(1)),
    deltaPct: Number((current.sharePct - baseline.sharePct).toFixed(1)),
  };
}
