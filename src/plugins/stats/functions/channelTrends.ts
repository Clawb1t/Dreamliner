import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { guildStatsChannelDaily } from "../../../db/schema.js";
import { dateRange, isAllTimeWindow } from "./daily.js";

export type ChannelTrend = {
  channelId: string;
  currentTotal: number;
  baselineTotal: number;
  /** baselineTotal normalized to the same length as the current window, for an apples-to-apples
   *  "typical activity over a period this long" comparison regardless of how much longer the
   *  baseline lookback is. */
  baselineMeanPerWindow: number;
  deltaPct: number;
  status: "growing" | "declining" | "emerging" | "stable";
};

const GROWTH_DELTA_PCT = 30;
const DECLINE_DELTA_PCT = -30;

async function sumMessagesByChannel(
  guildId: string,
  sinceDate: string,
  untilDateExclusive: string | null,
): Promise<Map<string, number>> {
  const conditions = [eq(guildStatsChannelDaily.guildId, guildId), gte(guildStatsChannelDaily.statDate, sinceDate)];
  if (untilDateExclusive) conditions.push(lt(guildStatsChannelDaily.statDate, untilDateExclusive));

  const rows = await getDb()
    .select({
      channelId: guildStatsChannelDaily.channelId,
      total: sql<number>`sum(${guildStatsChannelDaily.messages})`,
    })
    .from(guildStatsChannelDaily)
    .where(and(...conditions))
    .groupBy(guildStatsChannelDaily.channelId);

  return new Map(rows.map((row) => [row.channelId, Number(row.total)]));
}

/**
 * Per-channel message totals for the current window vs. a trailing baseline lookback, both
 * computed with SQL-side GROUP BY (never a per-channel-per-day pull into JS) — backs both the
 * Channel Analytics section and the channel_growth_decline/channel_emerging insights. `days`
 * follows the same StatsWindow convention as everywhere else; the all-time window uses a 30-day
 * "current" slice (a channel trend needs a bounded comparison period even when the page's overall
 * requested range is all-time).
 */
export async function getChannelTrendBreakdown(guildId: string, days: number): Promise<ChannelTrend[]> {
  const compareWindowDays = isAllTimeWindow(days) ? 30 : days;
  const baselineHorizonDays = Math.max(28, compareWindowDays * 4);
  const currentSince = dateRange(compareWindowDays)[0]!;
  const baselineSince = dateRange(compareWindowDays + baselineHorizonDays)[0]!;

  const [current, baseline] = await Promise.all([
    sumMessagesByChannel(guildId, currentSince, null),
    sumMessagesByChannel(guildId, baselineSince, currentSince),
  ]);

  const channelIds = new Set([...current.keys(), ...baseline.keys()]);
  const results: ChannelTrend[] = [];

  for (const channelId of channelIds) {
    const currentTotal = current.get(channelId) ?? 0;
    const baselineTotal = baseline.get(channelId) ?? 0;
    const baselineMeanPerWindow = baselineHorizonDays > 0 ? (baselineTotal / baselineHorizonDays) * compareWindowDays : 0;

    const deltaPct =
      baselineMeanPerWindow === 0
        ? currentTotal > 0
          ? 100
          : 0
        : ((currentTotal - baselineMeanPerWindow) / baselineMeanPerWindow) * 100;

    let status: ChannelTrend["status"] = "stable";
    if (baselineMeanPerWindow === 0 && currentTotal > 0) status = "emerging";
    else if (deltaPct >= GROWTH_DELTA_PCT) status = "growing";
    else if (deltaPct <= DECLINE_DELTA_PCT) status = "declining";

    results.push({
      channelId,
      currentTotal,
      baselineTotal,
      baselineMeanPerWindow: Number(baselineMeanPerWindow.toFixed(1)),
      deltaPct: Number(deltaPct.toFixed(1)),
      status,
    });
  }

  return results.sort((a, b) => b.currentTotal - a.currentTotal);
}

const SPARKLINE_DAYS = 14;

/**
 * Short zero-filled daily message-count series per channel, oldest → newest — for a sparkline next
 * to each channel's trend row, not the full growth/decline comparison above. Deliberately scoped
 * to an explicit `channelIds` list (the page's own top-N, not every channel in the guild) so this
 * stays a small, bounded query regardless of guild size.
 */
export async function getChannelDailySparklines(
  guildId: string,
  channelIds: string[],
  days: number = SPARKLINE_DAYS,
): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  if (channelIds.length === 0) return result;

  const dates = dateRange(days);
  const since = dates[0]!;

  const rows = await getDb()
    .select({
      channelId: guildStatsChannelDaily.channelId,
      statDate: guildStatsChannelDaily.statDate,
      messages: guildStatsChannelDaily.messages,
    })
    .from(guildStatsChannelDaily)
    .where(
      and(
        eq(guildStatsChannelDaily.guildId, guildId),
        gte(guildStatsChannelDaily.statDate, since),
        inArray(guildStatsChannelDaily.channelId, channelIds),
      ),
    );

  const byChannel = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const byDate = byChannel.get(row.channelId) ?? new Map<string, number>();
    byDate.set(row.statDate, row.messages);
    byChannel.set(row.channelId, byDate);
  }

  for (const channelId of channelIds) {
    const byDate = byChannel.get(channelId);
    result.set(
      channelId,
      dates.map((date) => byDate?.get(date) ?? 0),
    );
  }

  return result;
}
