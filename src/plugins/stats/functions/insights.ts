/**
 * The insight catalog runner. Every insight object below carries only numbers pulled from
 * already-computed query results, and a fixed per-type template string that interpolates *only*
 * those numbers — this file is the single place new insight copy gets written, specifically so no
 * insight can ever assert something the underlying data doesn't support. See
 * assertHeadlineIsTraceable at the bottom, which enforces this in non-production runs.
 */
import { getFilledDailyStats, getGuildHourlyHeatmap, isAllTimeWindow, type StatsWindow } from "./daily.js";
import { formatStatsWindowLong } from "./daily.js";
import { getFilledVoiceDailyStats } from "./voice.js";
import { getFilledModCaseDaily, getFilledAutomodHitDaily } from "./moderationStats.js";
import { getFilledGuildCommandDailyUses } from "./commandUsage.js";
import { getRetentionCohorts } from "./retention.js";
import { getChannelTrendBreakdown, type ChannelTrend } from "./channelTrends.js";
import { getEngagementConcentration } from "./concentration.js";
import { getNewMemberEngagementRate } from "./memberTrends.js";
import { getFilledIncidentSignalDaily } from "./incidentStats.js";
import { computeBaseline, computeWeekdayAdjustedBaseline, isInsightWorthy, type BaselineResult } from "./baseline.js";
import { analyzeSeries, weekdayName } from "./analysis.js";

export type InsightDomain = "activity" | "membership" | "engagement" | "channels" | "moderation" | "voice";
export type InsightSeverity = "significant" | "notable" | "info";
export type InsightDirection = "up" | "down" | "neutral";

export type InsightEvidenceRef =
  | { kind: "metric"; metric: string; window: string }
  | { kind: "series"; series: string; window: string }
  | { kind: "channel"; channelId: string; metric: string }
  | { kind: "event"; logEventIds: number[] };

/**
 * `headline`/`detail` may contain the literal placeholder token `{channel}` when the insight's
 * first `{kind:"channel"}` evidence entry names the channel the finding is about — this file has
 * no Guild object to resolve an ID to a display name, so name resolution is deliberately deferred
 * to the bridge layer (webStatsInsights.ts), which does a single deterministic substitution
 * (never freeform prose synthesis) before the payload goes out. A pre-substitution insight should
 * never be shown to a user as-is.
 */
export type Insight = {
  id: string;
  type: string;
  domain: InsightDomain;
  severity: InsightSeverity;
  score: number;
  direction: InsightDirection;
  metricValue: number;
  baselineValue: number;
  deltaPct: number;
  z: number | null;
  windowLabel: string;
  headline: string;
  detail: string;
  /** Any other real numbers referenced in headline/detail beyond metricValue/baselineValue/
   *  deltaPct/z (e.g. a supporting cohort size or count) — every one of these came from the same
   *  computed data as the rest of the insight, just isn't the primary metric being tracked. See
   *  assertHeadlineIsTraceable, which checks prose numbers against this set too. */
  supportingValues?: number[];
  evidence: InsightEvidenceRef[];
  relatedInsightIds?: string[];
};

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function scoreInsight(input: { z: number | null; deltaPct: number; currentTotal: number; minVolumeFloor: number }): number {
  const primaryTerm = input.z != null ? Math.min(Math.abs(input.z), 4) * 25 : Math.min(Math.abs(input.deltaPct), 100) * 1.0;
  const magnitudeTerm = Math.min(Math.abs(input.deltaPct), 100) * 0.3;
  const volumeRatio = input.minVolumeFloor > 0 ? Math.min(input.currentTotal / input.minVolumeFloor, 3) : 1;
  const volumeBonus = volumeRatio * 5;
  return round(primaryTerm + magnitudeTerm + volumeBonus, 2);
}

function severityFromScore(score: number): InsightSeverity {
  if (score >= 90) return "significant";
  if (score >= 60) return "notable";
  return "info";
}

function directionFromDelta(deltaPct: number): InsightDirection {
  if (Math.abs(deltaPct) < 1) return "neutral";
  return deltaPct > 0 ? "up" : "down";
}

/**
 * Fetches a daily-granularity series via `fetchAllTime` in its all-time mode (which each of these
 * functions already bounds to the guild's actual earliest tracked row — see getFilledDailyStats
 * etc.'s own all-time branch) and trims it to at most `desiredLength` most-recent entries.
 *
 * This exists specifically so computeBaseline never gets fed a zero-filled series that reaches
 * back further than real tracking history — fetching a *fixed* day count instead (e.g.
 * `getFilledXDaily(guildId, 120)`) would zero-fill every day in that count regardless of whether
 * the guild's tracking actually goes back that far, which would silently compare "this window" to
 * a partly-fabricated "typical" baseline of days that were never actually tracked. A short real
 * history correctly yields a shorter array here, which computeBaseline's own length check then
 * treats as "not enough baseline data yet" and suppresses the insight, rather than fabricating one.
 */
async function fetchRealLookback<T extends { statDate: string }>(
  fetchAllTime: (guildId: string, days: number) => Promise<T[]>,
  guildId: string,
  desiredLength: number,
): Promise<T[]> {
  const rows = await fetchAllTime(guildId, 0);
  return rows.length > desiredLength ? rows.slice(rows.length - desiredLength) : rows;
}

type BuildInsightInput = {
  id: string;
  type: string;
  domain: InsightDomain;
  metricValue: number;
  baselineValue: number;
  deltaPct: number;
  z: number | null;
  minVolumeFloor: number;
  windowLabel: string;
  headline: string;
  detail: string;
  supportingValues?: number[];
  evidence: InsightEvidenceRef[];
  relatedInsightIds?: string[];
};

function buildInsight(input: BuildInsightInput): Insight {
  const score = scoreInsight({ z: input.z, deltaPct: input.deltaPct, currentTotal: input.metricValue, minVolumeFloor: input.minVolumeFloor });
  return {
    id: input.id,
    type: input.type,
    domain: input.domain,
    severity: severityFromScore(score),
    score,
    direction: directionFromDelta(input.deltaPct),
    metricValue: input.metricValue,
    baselineValue: input.baselineValue,
    deltaPct: round(input.deltaPct),
    z: input.z != null ? round(input.z, 2) : null,
    windowLabel: input.windowLabel,
    headline: input.headline,
    detail: input.detail,
    supportingValues: input.supportingValues,
    evidence: input.evidence,
    relatedInsightIds: input.relatedInsightIds,
  };
}

// ---------------------------------------------------------------------------------------------
// Shared helper: baseline-driven insight from a single guild-wide daily series.
// ---------------------------------------------------------------------------------------------

function baselineWorthy(baseline: BaselineResult | null, minVolumeFloor: number, minAbsZ?: number, minAbsDeltaPct?: number): baseline is BaselineResult {
  if (!baseline) return false;
  return isInsightWorthy({ z: baseline.z, deltaPct: baseline.deltaPct, currentTotal: baseline.currentTotal, minVolumeFloor, minAbsZ, minAbsDeltaPct });
}

// ---------------------------------------------------------------------------------------------
// 1. activity_vs_baseline
// ---------------------------------------------------------------------------------------------

async function activityVsBaseline(guildId: string, days: StatsWindow, dailyMessages: number[], dates: string[], windowLabel: string): Promise<Insight[]> {
  const compareWindowDays = isAllTimeWindow(days) ? 30 : days;
  const baseline = computeBaseline(dailyMessages, dates, compareWindowDays);
  if (!baselineWorthy(baseline, 20)) return [];

  const direction = baseline.deltaPct > 0 ? "higher" : "lower";
  return [
    buildInsight({
      id: `activity_vs_baseline:${guildId}:${days}`,
      type: "activity_vs_baseline",
      domain: "activity",
      metricValue: baseline.currentTotal,
      baselineValue: round(baseline.baselineMean * compareWindowDays),
      deltaPct: baseline.deltaPct,
      z: baseline.z,
      minVolumeFloor: 20,
      windowLabel,
      headline: `Message activity is ${round(Math.abs(baseline.deltaPct))}% ${direction} than the server's normal average`,
      detail: `${baseline.currentTotal.toLocaleString()} messages in the last ${compareWindowDays} day${compareWindowDays === 1 ? "" : "s"}, vs. a typical ${round(baseline.baselineMean * compareWindowDays).toLocaleString()} over a period this long.`,
      evidence: [{ kind: "series", series: "messages", window: windowLabel }],
    }),
  ];
}

// ---------------------------------------------------------------------------------------------
// 2 & 13. channel_growth_decline / channel_emerging
// ---------------------------------------------------------------------------------------------

async function channelGrowthAndEmerging(guildId: string, days: StatsWindow, windowLabel: string): Promise<Insight[]> {
  const breakdown = await getChannelTrendBreakdown(guildId, days);
  if (breakdown.length === 0) return [];

  const currentWindowTotal = breakdown.reduce((sum, c) => sum + c.currentTotal, 0);
  const volumeFloor = (c: ChannelTrend) => c.currentTotal >= 25 || c.currentTotal >= currentWindowTotal * 0.05;

  const insights: Insight[] = [];

  const growing = breakdown
    .filter((c) => c.status === "growing" && Math.abs(c.deltaPct) >= 30 && volumeFloor(c))
    .slice(0, 2);
  for (const c of growing) {
    insights.push(
      buildInsight({
        id: `channel_growth_decline:${guildId}:${days}:${c.channelId}`,
        type: "channel_growth_decline",
        domain: "channels",
        metricValue: c.currentTotal,
        baselineValue: c.baselineMeanPerWindow,
        deltaPct: c.deltaPct,
        z: null,
        minVolumeFloor: 25,
        windowLabel,
        headline: `Recent activity growth is concentrated in {channel}`,
        detail: `{channel} is up ${round(Math.abs(c.deltaPct))}% vs. its normal traffic: ${c.currentTotal.toLocaleString()} messages this window vs. a typical ${c.baselineMeanPerWindow.toLocaleString()}.`,
        evidence: [{ kind: "channel", channelId: c.channelId, metric: "messages" }],
      }),
    );
  }

  const declining = breakdown.find((c) => c.status === "declining" && Math.abs(c.deltaPct) >= 30 && volumeFloor(c));
  if (declining) {
    insights.push(
      buildInsight({
        id: `channel_growth_decline:${guildId}:${days}:${declining.channelId}:down`,
        type: "channel_growth_decline",
        domain: "channels",
        metricValue: declining.currentTotal,
        baselineValue: declining.baselineMeanPerWindow,
        deltaPct: declining.deltaPct,
        z: null,
        minVolumeFloor: 25,
        windowLabel,
        headline: `{channel} has slowed down`,
        detail: `{channel} is down ${round(Math.abs(declining.deltaPct))}% vs. its normal traffic: ${declining.currentTotal.toLocaleString()} messages this window vs. a typical ${declining.baselineMeanPerWindow.toLocaleString()}.`,
        evidence: [{ kind: "channel", channelId: declining.channelId, metric: "messages" }],
      }),
    );
  }

  const emerging = breakdown.find((c) => c.status === "emerging" && c.currentTotal >= 25);
  if (emerging) {
    insights.push(
      buildInsight({
        id: `channel_emerging:${guildId}:${days}:${emerging.channelId}`,
        type: "channel_emerging",
        domain: "channels",
        metricValue: emerging.currentTotal,
        baselineValue: 0,
        deltaPct: 100,
        z: null,
        minVolumeFloor: 25,
        windowLabel,
        headline: `{channel} has taken off`,
        detail: `{channel} had little to no activity before this window and now has ${emerging.currentTotal.toLocaleString()} messages.`,
        evidence: [{ kind: "channel", channelId: emerging.channelId, metric: "messages" }],
      }),
    );
  }

  return insights;
}

// ---------------------------------------------------------------------------------------------
// 3. engagement_concentration_change
// ---------------------------------------------------------------------------------------------

async function engagementConcentrationChange(guildId: string, days: StatsWindow, windowLabel: string): Promise<Insight[]> {
  const concentration = await getEngagementConcentration(guildId, days);
  // baselineActiveUserCount === 0 means there's no real prior period to compare against (e.g. a
  // guild younger than the baseline horizon), not a genuine "0% concentration" observation — must
  // not be presented as "up from 0%".
  if (!concentration || concentration.activeUserCount < 30 || concentration.baselineActiveUserCount === 0 || Math.abs(concentration.deltaPct) < 8)
    return [];

  const direction = concentration.deltaPct > 0 ? "concentrated among a smaller group of members" : "spreading across more members";
  return [
    buildInsight({
      id: `engagement_concentration_change:${guildId}:${days}`,
      type: "engagement_concentration_change",
      domain: "engagement",
      metricValue: concentration.topDecileSharePct,
      baselineValue: concentration.baselineTopDecileSharePct,
      deltaPct: concentration.deltaPct,
      z: null,
      minVolumeFloor: 0,
      windowLabel,
      headline: `Activity is becoming increasingly ${direction}`,
      detail: `The most active 10% of posters (${concentration.activeUserCount} of them) now account for ${concentration.topDecileSharePct}% of messages, up from ${concentration.baselineTopDecileSharePct}%.`,
      supportingValues: [concentration.activeUserCount],
      evidence: [{ kind: "metric", metric: "engagement_concentration", window: windowLabel }],
    }),
  ];
}

// ---------------------------------------------------------------------------------------------
// 4. new_member_engagement_rate
// ---------------------------------------------------------------------------------------------

async function newMemberEngagementRate(guildId: string, days: StatsWindow, windowLabel: string): Promise<Insight[]> {
  const engagement = await getNewMemberEngagementRate(guildId, days);
  // baselineCohortSize === 0 means no one joined during the baseline period at all — not a real
  // "0% engaged" cohort to compare against.
  if (!engagement || engagement.cohortSize < 10 || engagement.baselineCohortSize === 0 || Math.abs(engagement.deltaPct) < 10)
    return [];

  const direction = engagement.deltaPct > 0 ? "higher" : "lower";
  return [
    buildInsight({
      id: `new_member_engagement_rate:${guildId}:${days}`,
      type: "new_member_engagement_rate",
      domain: "membership",
      metricValue: engagement.engagedPct,
      baselineValue: engagement.baselineEngagedPct,
      deltaPct: engagement.deltaPct,
      z: null,
      minVolumeFloor: 0,
      windowLabel,
      headline: `New members are engaging ${direction} than usual`,
      detail: `${engagement.engagedPct}% of the ${engagement.cohortSize} members who joined posted at least once in their first week, vs. a typical ${engagement.baselineEngagedPct}%.`,
      supportingValues: [engagement.cohortSize],
      evidence: [{ kind: "metric", metric: "new_member_engagement", window: windowLabel }],
    }),
  ];
}

// ---------------------------------------------------------------------------------------------
// 5. moderation_volume_vs_baseline
// ---------------------------------------------------------------------------------------------

async function moderationVolumeVsBaseline(guildId: string, days: StatsWindow, windowLabel: string): Promise<Insight[]> {
  const compareWindowDays = isAllTimeWindow(days) ? 30 : days;
  const lookbackDays = compareWindowDays + Math.max(28, compareWindowDays * 4);
  const [caseDaily, automodDaily] = await Promise.all([
    fetchRealLookback(getFilledModCaseDaily, guildId, lookbackDays),
    // automod_hits is hard-pruned at 30 days regardless of window requested, so its own all-time
    // fetch already comes back capped — fetchRealLookback here just avoids re-deriving that cap.
    fetchRealLookback(getFilledAutomodHitDaily, guildId, Math.min(lookbackDays, 30)),
  ]);

  const insights: Insight[] = [];

  if (caseDaily.length > 0) {
    const dates = caseDaily.map((r) => r.statDate);
    const values = caseDaily.map((r) => r.total);
    const baseline = computeBaseline(values, dates, compareWindowDays);
    if (baselineWorthy(baseline, 5)) {
      const direction = baseline.deltaPct > 0 ? "up" : "down";
      insights.push(
        buildInsight({
          id: `moderation_volume_vs_baseline:${guildId}:${days}:cases`,
          type: "moderation_volume_vs_baseline",
          domain: "moderation",
          metricValue: baseline.currentTotal,
          baselineValue: round(baseline.baselineMean * compareWindowDays),
          deltaPct: baseline.deltaPct,
          z: baseline.z,
          minVolumeFloor: 5,
          windowLabel,
          headline: `Moderation case volume is ${direction} ${round(Math.abs(baseline.deltaPct))}% vs. normal`,
          detail: `${baseline.currentTotal.toLocaleString()} moderation cases in the last ${compareWindowDays} day${compareWindowDays === 1 ? "" : "s"}, vs. a typical ${round(baseline.baselineMean * compareWindowDays).toLocaleString()}.`,
          evidence: [{ kind: "series", series: "moderation_cases", window: windowLabel }],
        }),
      );
    }
  }

  if (automodDaily.length > 0) {
    const dates = automodDaily.map((r) => r.statDate);
    const values = automodDaily.map((r) => r.hits);
    const baseline = computeBaseline(values, dates, Math.min(compareWindowDays, 30));
    if (baselineWorthy(baseline, 10)) {
      const direction = baseline.deltaPct > 0 ? "up" : "down";
      insights.push(
        buildInsight({
          id: `moderation_volume_vs_baseline:${guildId}:${days}:automod`,
          type: "moderation_volume_vs_baseline",
          domain: "moderation",
          metricValue: baseline.currentTotal,
          baselineValue: round(baseline.baselineMean * Math.min(compareWindowDays, 30)),
          deltaPct: baseline.deltaPct,
          z: baseline.z,
          minVolumeFloor: 10,
          windowLabel,
          headline: `Automod activity is ${direction} ${round(Math.abs(baseline.deltaPct))}% vs. normal`,
          detail: `${baseline.currentTotal.toLocaleString()} automod hits recently, vs. a typical ${round(baseline.baselineMean * Math.min(compareWindowDays, 30)).toLocaleString()} (automod history only goes back 30 days).`,
          evidence: [{ kind: "series", series: "automod_hits", window: windowLabel }],
        }),
      );
    }
  }

  return insights;
}

// ---------------------------------------------------------------------------------------------
// 6. unusual_day_detection
// ---------------------------------------------------------------------------------------------

async function unusualDayDetection(guildId: string, dailyMessages: number[], dates: string[], windowLabel: string): Promise<Insight[]> {
  const results = computeWeekdayAdjustedBaseline(dailyMessages, dates);
  const flagged = results
    .filter((r): r is NonNullable<typeof r> => r != null && Math.abs(r.z) >= 2.5 && r.value >= 15)
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  if (flagged.length === 0) return [];

  const day = flagged[0]!;
  const weekday = weekdayName(new Date(`${day.date}T12:00:00Z`).getUTCDay());
  const multiple = day.z > 0 ? round(day.deltaPct / 100 + 1, 1) : null;

  return [
    buildInsight({
      id: `unusual_day_detection:${guildId}:${day.date}`,
      type: "unusual_day_detection",
      domain: "activity",
      metricValue: day.value,
      baselineValue: round(day.value / (1 + day.deltaPct / 100)),
      deltaPct: day.deltaPct,
      z: day.z,
      minVolumeFloor: 15,
      windowLabel,
      headline: `${day.date} was an unusual activity day`,
      detail:
        day.z > 0
          ? `Message volume was ${multiple}x the typical ${weekday} (${day.value.toLocaleString()} messages).`
          : `Message volume was well below the typical ${weekday} (${day.value.toLocaleString()} messages, ${round(Math.abs(day.deltaPct))}% lower than normal).`,
      supportingValues: multiple != null ? [multiple] : undefined,
      evidence: [{ kind: "series", series: "messages", window: day.date }],
    }),
  ];
}

// ---------------------------------------------------------------------------------------------
// 7. peak_period_shift (weekday-only for now — hourly-bucket-backed hour-level version is a
// direct follow-on once enough guildStatsHourlyBucket history has accumulated).
// ---------------------------------------------------------------------------------------------

async function peakPeriodShift(guildId: string, windowAnalysis: ReturnType<typeof analyzeSeries>, windowLabel: string): Promise<Insight[]> {
  const heatmap = await getGuildHourlyHeatmap(guildId);
  const lifetimeByWeekday = Array.from({ length: 7 }, () => 0);
  for (const cell of heatmap) lifetimeByWeekday[cell.weekday]! += cell.messages;
  const lifetimeTotal = lifetimeByWeekday.reduce((s, v) => s + v, 0);
  if (lifetimeTotal < 50) return [];

  let lifetimeBusiest = 0;
  lifetimeByWeekday.forEach((total, i) => {
    if (total > lifetimeByWeekday[lifetimeBusiest]!) lifetimeBusiest = i;
  });

  if (windowAnalysis.busiestWeekday === lifetimeBusiest || windowAnalysis.total < 20) return [];

  return [
    buildInsight({
      id: `peak_period_shift:${guildId}:${windowLabel}`,
      type: "peak_period_shift",
      domain: "activity",
      metricValue: windowAnalysis.weekdayTotals[windowAnalysis.busiestWeekday]!,
      baselineValue: windowAnalysis.weekdayTotals[lifetimeBusiest]!,
      deltaPct: 0,
      z: null,
      minVolumeFloor: 20,
      windowLabel,
      headline: `This window's busiest day differs from the server's usual pattern`,
      detail: `${weekdayName(windowAnalysis.busiestWeekday)} was busiest this window; ${weekdayName(lifetimeBusiest)} is usually the server's busiest day overall.`,
      evidence: [{ kind: "series", series: "messages_by_weekday", window: windowLabel }],
    }),
  ];
}

// ---------------------------------------------------------------------------------------------
// 8. member_growth_activity_correlation (cross-domain)
// ---------------------------------------------------------------------------------------------

function memberGrowthActivityCorrelation(
  guildId: string,
  dailyRows: { statDate: string; messages: number; joins: number; leaves: number }[],
  windowLabel: string,
): Insight[] {
  if (dailyRows.length < 4) return [];
  const dates = dailyRows.map((r) => r.statDate);
  const messages = dailyRows.map((r) => r.messages);
  const net = dailyRows.map((r) => r.joins - r.leaves);

  const messagesAnalysis = analyzeSeries(messages, dates);
  const netAnalysis = analyzeSeries(net, dates);
  if (messagesAnalysis.trend !== "up" || netAnalysis.trend !== "up") return [];

  const peakGapDays = Math.abs(messagesAnalysis.peakIndex - netAnalysis.peakIndex);
  if (peakGapDays > 3) return [];

  return [
    buildInsight({
      id: `member_growth_activity_correlation:${guildId}:${windowLabel}`,
      type: "member_growth_activity_correlation",
      domain: "membership",
      metricValue: messagesAnalysis.trendPct,
      baselineValue: 0,
      deltaPct: messagesAnalysis.trendPct,
      z: null,
      minVolumeFloor: 0,
      windowLabel,
      headline: `Member growth is coinciding with higher message activity`,
      detail: `Both member growth and message activity trended up this window, with their peak days ${peakGapDays} day${peakGapDays === 1 ? "" : "s"} apart (${dates[messagesAnalysis.peakIndex]} vs. ${dates[netAnalysis.peakIndex]}).`,
      evidence: [
        { kind: "series", series: "messages", window: windowLabel },
        { kind: "series", series: "net_members", window: windowLabel },
      ],
    }),
  ];
}

// ---------------------------------------------------------------------------------------------
// 9. retention_shift
// ---------------------------------------------------------------------------------------------

async function retentionShift(guildId: string, windowLabel: string): Promise<Insight[]> {
  const cohorts = await getRetentionCohorts(guildId, 7);
  const resolved = cohorts.filter((c) => c.retainedAt.find((r) => r.days === 7)?.pct != null && c.cohortSize >= 10);
  if (resolved.length < 2) return [];

  const latest = resolved[resolved.length - 1]!;
  const prior = resolved.slice(0, -1);
  const latestPct = latest.retainedAt.find((r) => r.days === 7)!.pct!;
  const priorAvg = prior.reduce((sum, c) => sum + c.retainedAt.find((r) => r.days === 7)!.pct!, 0) / prior.length;
  const deltaPct = latestPct - priorAvg;
  if (Math.abs(deltaPct) < 10) return [];

  const direction = deltaPct > 0 ? "improved" : "declined";
  return [
    buildInsight({
      id: `retention_shift:${guildId}:${latest.cohortStart}`,
      type: "retention_shift",
      domain: "membership",
      metricValue: latestPct,
      baselineValue: round(priorAvg),
      deltaPct,
      z: null,
      minVolumeFloor: 0,
      windowLabel,
      headline: `7-day new-member retention has ${direction}`,
      detail: `${latestPct}% of the ${latest.cohortSize} members who joined the week of ${latest.cohortStart} were still in the server a week later, vs. a typical ${round(priorAvg)}%.`,
      supportingValues: [latest.cohortSize],
      evidence: [{ kind: "metric", metric: "retention_cohorts", window: windowLabel }],
    }),
  ];
}

// ---------------------------------------------------------------------------------------------
// 10. voice_activity_shift
// ---------------------------------------------------------------------------------------------

async function voiceActivityShift(guildId: string, days: StatsWindow, windowLabel: string): Promise<Insight[]> {
  const compareWindowDays = isAllTimeWindow(days) ? 30 : days;
  const lookbackDays = compareWindowDays + Math.max(28, compareWindowDays * 4);
  const voiceDaily = await fetchRealLookback(getFilledVoiceDailyStats, guildId, lookbackDays);
  if (voiceDaily.length === 0) return [];

  const dates = voiceDaily.map((r) => r.statDate);
  const values = voiceDaily.map((r) => r.minutes);
  const baseline = computeBaseline(values, dates, compareWindowDays);
  if (!baselineWorthy(baseline, 60)) return [];

  const direction = baseline.deltaPct > 0 ? "up" : "down";
  return [
    buildInsight({
      id: `voice_activity_shift:${guildId}:${days}`,
      type: "voice_activity_shift",
      domain: "voice",
      metricValue: baseline.currentTotal,
      baselineValue: round(baseline.baselineMean * compareWindowDays),
      deltaPct: baseline.deltaPct,
      z: baseline.z,
      minVolumeFloor: 60,
      windowLabel,
      headline: `Voice activity is ${direction} ${round(Math.abs(baseline.deltaPct))}% vs. normal`,
      detail: `${baseline.currentTotal.toLocaleString()} voice-minutes in the last ${compareWindowDays} day${compareWindowDays === 1 ? "" : "s"}, vs. a typical ${round(baseline.baselineMean * compareWindowDays).toLocaleString()}.`,
      evidence: [{ kind: "series", series: "voice_minutes", window: windowLabel }],
    }),
  ];
}

// ---------------------------------------------------------------------------------------------
// 11. command_feature_adoption_shift
// ---------------------------------------------------------------------------------------------

async function commandAdoptionShift(guildId: string, days: StatsWindow, windowLabel: string): Promise<Insight[]> {
  const compareWindowDays = isAllTimeWindow(days) ? 30 : days;
  const lookbackDays = compareWindowDays + Math.max(28, compareWindowDays * 4);
  const commandDaily = await fetchRealLookback(getFilledGuildCommandDailyUses, guildId, lookbackDays);
  if (commandDaily.length === 0) return [];

  const dates = commandDaily.map((r) => r.statDate);
  const values = commandDaily.map((r) => r.uses);
  const baseline = computeBaseline(values, dates, compareWindowDays);
  if (!baselineWorthy(baseline, 15)) return [];

  const direction = baseline.deltaPct > 0 ? "up" : "down";
  return [
    buildInsight({
      id: `command_feature_adoption_shift:${guildId}:${days}`,
      type: "command_feature_adoption_shift",
      domain: "engagement",
      metricValue: baseline.currentTotal,
      baselineValue: round(baseline.baselineMean * compareWindowDays),
      deltaPct: baseline.deltaPct,
      z: baseline.z,
      minVolumeFloor: 15,
      windowLabel,
      headline: `Command usage is ${direction} ${round(Math.abs(baseline.deltaPct))}% vs. normal`,
      detail: `${baseline.currentTotal.toLocaleString()} command uses in the last ${compareWindowDays} day${compareWindowDays === 1 ? "" : "s"}, vs. a typical ${round(baseline.baselineMean * compareWindowDays).toLocaleString()}.`,
      evidence: [{ kind: "series", series: "commands", window: windowLabel }],
    }),
  ];
}

// ---------------------------------------------------------------------------------------------
// 12. incident_signal_trend (conditional — only when Incident Response is enabled and has data)
// ---------------------------------------------------------------------------------------------

async function incidentSignalTrend(guildId: string, days: StatsWindow, windowLabel: string): Promise<Insight[]> {
  const compareWindowDays = isAllTimeWindow(days) ? 30 : days;
  const lookbackDays = compareWindowDays + Math.max(28, compareWindowDays * 4);
  // Not fetchRealLookback: getFilledIncidentSignalDaily returns null (not []) when Incident
  // Response is disabled, a distinction that must survive here (see its own doc comment).
  const allTime = await getFilledIncidentSignalDaily(guildId, 0);
  if (!allTime) return [];
  const daily = allTime.length > lookbackDays ? allTime.slice(allTime.length - lookbackDays) : allTime;
  if (daily.length === 0) return [];

  const dates = daily.map((r) => r.statDate);
  const values = daily.map((r) => r.count);
  const baseline = computeBaseline(values, dates, compareWindowDays);
  if (!baselineWorthy(baseline, 5)) return [];

  const direction = baseline.deltaPct > 0 ? "up" : "down";
  return [
    buildInsight({
      id: `incident_signal_trend:${guildId}:${days}`,
      type: "incident_signal_trend",
      domain: "moderation",
      metricValue: baseline.currentTotal,
      baselineValue: round(baseline.baselineMean * compareWindowDays),
      deltaPct: baseline.deltaPct,
      z: baseline.z,
      minVolumeFloor: 5,
      windowLabel,
      headline: `Incident signal activity is ${direction} ${round(Math.abs(baseline.deltaPct))}% vs. normal`,
      detail: `${baseline.currentTotal.toLocaleString()} correlated safety signals (automod/raid/impersonation/scam) recently, vs. a typical ${round(baseline.baselineMean * compareWindowDays).toLocaleString()}.`,
      evidence: [{ kind: "series", series: "incident_signals", window: windowLabel }],
    }),
  ];
}

// ---------------------------------------------------------------------------------------------
// 14. moderation_membership_correlation
// ---------------------------------------------------------------------------------------------

async function moderationMembershipCorrelation(
  guildId: string,
  dailyRows: { statDate: string; leaves: number }[],
  windowLabel: string,
): Promise<Insight[]> {
  const totalLeaves = dailyRows.reduce((sum, r) => sum + r.leaves, 0);
  if (totalLeaves < 10) return [];

  // A within-window spike check (not computeBaseline's earlier-vs-current split — there's no
  // "earlier" period here, just "is this day unusually high relative to the rest of this same
  // window"), so mean/stdev are taken directly over the window's own case-count days.
  const caseDaily = await getFilledModCaseDaily(guildId, dailyRows.length);
  if (caseDaily.length === 0) return [];

  const caseValues = caseDaily.map((r) => r.total);
  const caseMean = caseValues.reduce((sum, v) => sum + v, 0) / caseValues.length;
  const spikeDates = new Set(caseDaily.filter((r) => r.total >= 3 && r.total >= caseMean * 1.5).map((r) => r.statDate));
  if (spikeDates.size === 0) return [];

  let clusteredLeaves = 0;
  for (const row of dailyRows) {
    if (row.leaves === 0) continue;
    const rowMs = Date.parse(`${row.statDate}T12:00:00Z`);
    const nearSpike = [...spikeDates].some((spikeDate) => Math.abs(rowMs - Date.parse(`${spikeDate}T12:00:00Z`)) <= 2 * 86_400_000);
    if (nearSpike) clusteredLeaves += row.leaves;
  }

  const clusteredPct = (clusteredLeaves / totalLeaves) * 100;
  if (clusteredPct < 25) return [];

  return [
    buildInsight({
      id: `moderation_membership_correlation:${guildId}:${dailyRows[0]?.statDate ?? ""}`,
      type: "moderation_membership_correlation",
      domain: "moderation",
      metricValue: clusteredLeaves,
      baselineValue: totalLeaves,
      deltaPct: clusteredPct,
      z: null,
      minVolumeFloor: 10,
      windowLabel,
      headline: `Member departures cluster around moderation activity`,
      detail: `${round(clusteredPct)}% of this window's departures (${clusteredLeaves} of ${totalLeaves}) fall within 48 hours of a moderation-case spike. This is a correlation in the timing, not a claim about why any individual member left.`,
      evidence: [
        { kind: "series", series: "moderation_cases", window: windowLabel },
        { kind: "series", series: "leaves", window: windowLabel },
      ],
    }),
  ];
}

// ---------------------------------------------------------------------------------------------
// Catalog runner
// ---------------------------------------------------------------------------------------------

const MAX_PER_DOMAIN = 3;
const MAX_TOTAL = 8;

export async function buildGuildInsights(guildId: string, days: StatsWindow): Promise<Insight[]> {
  const windowLabel = formatStatsWindowLong(days);
  const currentWindowDays = isAllTimeWindow(days) ? 30 : days;
  const lookbackDays = currentWindowDays + Math.max(28, currentWindowDays * 4);
  const dailyRows = await fetchRealLookback(getFilledDailyStats, guildId, lookbackDays);
  if (dailyRows.length === 0) return [];
  const dates = dailyRows.map((r) => r.statDate);
  const messages = dailyRows.map((r) => r.messages);

  const currentWindowRows = dailyRows.slice(-currentWindowDays);
  const windowAnalysis = analyzeSeries(
    currentWindowRows.map((r) => r.messages),
    currentWindowRows.map((r) => r.statDate),
  );

  const groups = await Promise.all([
    activityVsBaseline(guildId, days, messages, dates, windowLabel),
    channelGrowthAndEmerging(guildId, days, windowLabel),
    engagementConcentrationChange(guildId, days, windowLabel),
    newMemberEngagementRate(guildId, days, windowLabel),
    moderationVolumeVsBaseline(guildId, days, windowLabel),
    unusualDayDetection(guildId, messages, dates, windowLabel),
    peakPeriodShift(guildId, windowAnalysis, windowLabel),
    Promise.resolve(memberGrowthActivityCorrelation(guildId, currentWindowRows, windowLabel)),
    retentionShift(guildId, windowLabel),
    voiceActivityShift(guildId, days, windowLabel),
    commandAdoptionShift(guildId, days, windowLabel),
    incidentSignalTrend(guildId, days, windowLabel),
    moderationMembershipCorrelation(guildId, currentWindowRows, windowLabel),
  ]);

  const all = groups.flat();
  if (process.env.NODE_ENV !== "production") {
    for (const insight of all) assertHeadlineIsTraceable(insight);
  }

  const byDomain = new Map<InsightDomain, Insight[]>();
  for (const insight of all.sort((a, b) => b.score - a.score)) {
    const bucket = byDomain.get(insight.domain) ?? [];
    if (bucket.length >= MAX_PER_DOMAIN) continue;
    bucket.push(insight);
    byDomain.set(insight.domain, bucket);
  }

  return [...byDomain.values()]
    .flat()
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TOTAL);
}

// ---------------------------------------------------------------------------------------------
// Anti-fabrication guard
// ---------------------------------------------------------------------------------------------

/**
 * Extracts every number that appears in an insight's rendered headline/detail and checks each one
 * is traceable to a field actually carried on the insight object (metricValue/baselineValue/
 * deltaPct/z, or embedded evidence identifiers) — a real guard against a future copy edit silently
 * introducing a number the underlying computation doesn't support. Throws in non-production so it
 * fails loudly in dev/CI rather than shipping a fabricated-looking claim.
 */
export function assertHeadlineIsTraceable(insight: Insight): void {
  const text = `${insight.headline} ${insight.detail}`;
  const numbers = text.match(/-?\d[\d,]*\.?\d*/g) ?? [];

  const tracedValues = [
    insight.metricValue,
    insight.baselineValue,
    insight.deltaPct,
    Math.abs(insight.deltaPct),
    insight.z ?? 0,
    ...(insight.supportingValues ?? []),
  ];
  // Derived/rounded display values (e.g. a baseline-per-window figure re-rounded for prose, or a
  // "Nx" multiple) are computed straight from these fields at render time, so allow anything
  // within a generous tolerance rather than demanding an exact string match — the guarantee this
  // defends is "no invented number", not "no arithmetic".
  const tolerance = (base: number) => Math.max(1, Math.abs(base) * 0.15);

  for (const raw of numbers) {
    const n = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    if (n === new Date().getFullYear() || Math.abs(n) <= 31) continue; // dates like "2026" / day-of-month digits
    const traceable = tracedValues.some((base) => Math.abs(n - Math.abs(base)) <= tolerance(base));
    if (!traceable) {
      throw new Error(
        `Insight "${insight.type}" (${insight.id}) headline/detail references ${n}, which doesn't trace back to metricValue/baselineValue/deltaPct/z/supportingValues (${JSON.stringify(
          {
            metricValue: insight.metricValue,
            baselineValue: insight.baselineValue,
            deltaPct: insight.deltaPct,
            z: insight.z,
            supportingValues: insight.supportingValues,
          },
        )}). Fix the template or carry the number as a real field.`,
      );
    }
  }
}
