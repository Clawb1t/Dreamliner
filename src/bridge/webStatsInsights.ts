/**
 * Bridge payload builders for the Server Intelligence Dashboard's new sections — kept separate
 * from webStats.ts (the existing Overview payload builder) so that file doesn't grow further.
 * Each builder here follows the same shape/convention as buildWebServerStats: resolve Discord
 * identity where needed, return a plain JSON-serializable object, no caching decisions made here
 * (dashboardBridge.ts wraps each route in the shared `cached()` helper).
 */
import type { Guild } from "discord.js";
import {
  buildGuildInsights,
  type Insight,
  type InsightEvidenceRef,
} from "../plugins/stats/functions/insights.js";
import {
  formatStatsWindowLong,
  isValidStatsWindow,
  getFilledDailyStatsInRange,
  getRollingHourlyTotals,
  type StatsWindow,
} from "../plugins/stats/functions/daily.js";
import { analyzeSeries, weekdayName } from "../plugins/stats/functions/analysis.js";
import { getFilledVoiceDailyStats } from "../plugins/stats/functions/voice.js";
import { getFilledGuildCommandDailyUses } from "../plugins/stats/functions/commandUsage.js";
import { getRetentionCohorts } from "../plugins/stats/functions/retention.js";
import { getChannelDailySparklines, getChannelTrendBreakdown } from "../plugins/stats/functions/channelTrends.js";
import { getEngagementConcentration } from "../plugins/stats/functions/concentration.js";
import { getNewMemberEngagementRate } from "../plugins/stats/functions/memberTrends.js";
import {
  getFilledModCaseDaily,
  getFilledAutomodHitDaily,
  getModCaseTypeBreakdown,
  getTopAutomodRules,
  AUTOMOD_HIT_RETENTION_DAYS,
} from "../plugins/stats/functions/moderationStats.js";
import { getFilledIncidentSignalDaily } from "../plugins/stats/functions/incidentStats.js";
import { getMetricCorrelations, METRIC_LABELS } from "../plugins/stats/functions/correlation.js";
import { getFilledDailyStats, getGuildHourlyHeatmap } from "../plugins/stats/functions/daily.js";
import { getDb } from "../db/client.js";

export type WebStatsIntelQuery = { days: StatsWindow } | { from: string; to: string };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Same `?days=` convention as parseWebStatsQuery (webStats.ts), plus an alternate `?from=&to=`
 *  custom-range mode. Falls back to the 14-day default on anything unparseable, same as today. */
export function parseWebStatsIntelQuery(url: URL): WebStatsIntelQuery {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from && to && ISO_DATE_RE.test(from) && ISO_DATE_RE.test(to) && from <= to) {
    return { from, to };
  }
  const raw = Number(url.searchParams.get("days") ?? 14);
  return { days: isValidStatsWindow(raw) ? raw : 14 };
}

function resolveChannelName(guild: Guild, channelId: string): string {
  const channel = guild.channels.cache.get(channelId);
  return channel && "name" in channel && channel.name ? `#${channel.name}` : `#${channelId}`;
}

export type WebInsightEvidence =
  | { kind: "metric"; metric: string; window: string }
  | { kind: "series"; series: string; window: string }
  | { kind: "channel"; channelId: string; channelName: string; metric: string }
  | { kind: "event"; logEventIds: number[] };

export type WebInsight = Omit<Insight, "evidence"> & { evidence: WebInsightEvidence[] };

function resolveEvidence(guild: Guild, ref: InsightEvidenceRef): WebInsightEvidence {
  if (ref.kind === "channel") {
    return { ...ref, channelName: resolveChannelName(guild, ref.channelId) };
  }
  return ref;
}

/**
 * Substitutes the literal `{channel}` placeholder (see insights.ts's Insight type doc comment)
 * with the resolved name of the insight's first channel-evidence entry — the one deterministic,
 * non-fabricating name substitution insights.ts defers to this layer because it has no Guild
 * object of its own.
 */
function resolveInsightCopy(guild: Guild, insight: Insight): WebInsight {
  const evidence = insight.evidence.map((ref) => resolveEvidence(guild, ref));
  const channelEvidence = evidence.find((e): e is Extract<WebInsightEvidence, { kind: "channel" }> => e.kind === "channel");
  const headline = channelEvidence ? insight.headline.replaceAll("{channel}", channelEvidence.channelName) : insight.headline;
  const detail = channelEvidence ? insight.detail.replaceAll("{channel}", channelEvidence.channelName) : insight.detail;
  return { ...insight, headline, detail, evidence };
}

function windowFromQuery(query: WebStatsIntelQuery): StatsWindow {
  return "days" in query ? query.days : 30;
}

export async function buildWebGuildInsights(guild: Guild, query: WebStatsIntelQuery) {
  const days = windowFromQuery(query);
  const insights = await buildGuildInsights(guild.id, days);
  return {
    guild: { id: guild.id, name: guild.name, icon: guild.icon, memberCount: guild.memberCount },
    window: days,
    windowLabel: formatStatsWindowLong(days),
    generatedAt: new Date().toISOString(),
    insights: insights.map((insight) => resolveInsightCopy(guild, insight)),
  };
}

export async function buildWebGuildActivityAnalytics(guild: Guild, query: WebStatsIntelQuery) {
  const days = windowFromQuery(query);
  const daily =
    "from" in query
      ? await getFilledDailyStatsInRange(guild.id, query.from, query.to)
      : await getFilledDailyStats(guild.id, days);
  const dates = daily.map((r) => r.statDate);

  const [voiceDaily, commandDaily, heatmap, todayRow, rolling24h] = await Promise.all([
    "from" in query ? Promise.resolve([]) : getFilledVoiceDailyStats(guild.id, days),
    "from" in query ? Promise.resolve([]) : getFilledGuildCommandDailyUses(guild.id, days),
    getGuildHourlyHeatmap(guild.id),
    getFilledDailyStats(guild.id, 1),
    getRollingHourlyTotals(guild.id, 24),
  ]);

  return {
    guild: { id: guild.id, name: guild.name, icon: guild.icon, memberCount: guild.memberCount },
    window: "from" in query ? null : days,
    windowLabel: "from" in query ? `${query.from} – ${query.to}` : formatStatsWindowLong(days),
    series: {
      daily,
      voice: voiceDaily,
      commands: commandDaily,
      weekday: {
        messages: analyzeSeries(daily.map((r) => r.messages), dates).weekdayTotals.map((value, i) => ({ day: weekdayName(i), value })),
      },
    },
    heatmap,
    today: todayRow[0] ?? null,
    rolling24h,
  };
}

export async function buildWebGuildMemberAnalytics(guild: Guild, query: WebStatsIntelQuery) {
  const days = windowFromQuery(query);
  const daily = "from" in query ? await getFilledDailyStatsInRange(guild.id, query.from, query.to) : await getFilledDailyStats(guild.id, days);

  const [retention, newMemberEngagement, concentration] = await Promise.all([
    getRetentionCohorts(guild.id, 7),
    getNewMemberEngagementRate(guild.id, days),
    getEngagementConcentration(guild.id, days),
  ]);

  return {
    guild: { id: guild.id, name: guild.name, icon: guild.icon, memberCount: guild.memberCount },
    window: "from" in query ? null : days,
    windowLabel: "from" in query ? `${query.from} – ${query.to}` : formatStatsWindowLong(days),
    series: {
      joins: daily.map((r) => ({ statDate: r.statDate, value: r.joins })),
      leaves: daily.map((r) => ({ statDate: r.statDate, value: r.leaves })),
      net: daily.map((r) => ({ statDate: r.statDate, value: r.joins - r.leaves })),
    },
    retention: { cohortDays: 7, cohorts: retention },
    newMemberEngagement,
    concentration,
  };
}

export async function buildWebGuildChannelAnalytics(guild: Guild, query: WebStatsIntelQuery) {
  const days = windowFromQuery(query);
  const breakdown = await getChannelTrendBreakdown(guild.id, "from" in query ? 30 : days);
  const top = breakdown.slice(0, 50);
  const sparklines = await getChannelDailySparklines(guild.id, top.map((c) => c.channelId));
  const channels = top.map((c) => ({
    ...c,
    name: resolveChannelName(guild, c.channelId),
    sparkline: sparklines.get(c.channelId) ?? [],
  }));

  return {
    guild: { id: guild.id, name: guild.name, icon: guild.icon, memberCount: guild.memberCount },
    window: "from" in query ? null : days,
    windowLabel: "from" in query ? `${query.from} – ${query.to}` : formatStatsWindowLong(days),
    channels,
  };
}

export async function buildWebGuildModerationAnalytics(guild: Guild, query: WebStatsIntelQuery) {
  const days = windowFromQuery(query);
  const effectiveDays = "from" in query ? 30 : days;

  const [caseDaily, caseTypes, automodDaily, topRules, incidentDaily, impersonation, scamProtect] = await Promise.all([
    getFilledModCaseDaily(guild.id, effectiveDays),
    getModCaseTypeBreakdown(guild.id, effectiveDays),
    getFilledAutomodHitDaily(guild.id, effectiveDays),
    getTopAutomodRules(guild.id, effectiveDays),
    getFilledIncidentSignalDaily(guild.id, effectiveDays),
    resolveImpersonationTrend(guild.id, effectiveDays),
    resolveScamProtectTrend(guild.id, effectiveDays),
  ]);

  return {
    guild: { id: guild.id, name: guild.name, icon: guild.icon, memberCount: guild.memberCount },
    window: "from" in query ? null : days,
    windowLabel: "from" in query ? `${query.from} – ${query.to}` : formatStatsWindowLong(days),
    cases: { series: caseDaily, typeBreakdown: caseTypes },
    automod: { series: automodDaily, topRules, retentionDays: AUTOMOD_HIT_RETENTION_DAYS },
    incidents: incidentDaily ? { series: incidentDaily } : null,
    impersonation,
    scamProtect,
  };
}

export async function buildWebGuildCorrelations(guild: Guild, query: WebStatsIntelQuery) {
  const days = windowFromQuery(query);
  const pairs = await getMetricCorrelations(guild.id, "from" in query ? 90 : days);

  return {
    guild: { id: guild.id, name: guild.name, icon: guild.icon, memberCount: guild.memberCount },
    window: "from" in query ? null : days,
    windowLabel: "from" in query ? `${query.from} – ${query.to}` : formatStatsWindowLong(days),
    metricLabels: METRIC_LABELS,
    pairs,
  };
}

async function resolveImpersonationTrend(guildId: string, days: number) {
  const { configManager } = await import("../config/manager.js");
  const { pluginEnabled } = await import("../core/pluginCommand.js");
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  if (!pluginEnabled(guildConfig, "impersonation")) return null;

  const { impersonationAlerts } = await import("../db/schema.js");
  const { and, eq, gte, sql } = await import("drizzle-orm");
  const { dateRange, dateRangeInclusive, isAllTimeWindow, statDate } = await import("../plugins/stats/functions/daily.js");

  if (isAllTimeWindow(days)) {
    const rows = await getDb()
      .select({ statDate: sql<string>`date(${impersonationAlerts.createdAt}, 'unixepoch')`, count: sql<number>`count(*)` })
      .from(impersonationAlerts)
      .where(eq(impersonationAlerts.guildId, guildId))
      .groupBy(sql`date(${impersonationAlerts.createdAt}, 'unixepoch')`);
    if (rows.length === 0) return { series: [] };
    const byDate = new Map(rows.map((r) => [r.statDate, r.count]));
    const earliest = [...byDate.keys()].sort()[0]!;
    const series = dateRangeInclusive(earliest, statDate()).map((date) => ({ statDate: date, count: byDate.get(date) ?? 0 }));
    return { series };
  }

  const since = new Date(`${dateRange(days)[0]!}T00:00:00.000Z`);
  const rows = await getDb()
    .select({ statDate: sql<string>`date(${impersonationAlerts.createdAt}, 'unixepoch')`, count: sql<number>`count(*)` })
    .from(impersonationAlerts)
    .where(and(eq(impersonationAlerts.guildId, guildId), gte(impersonationAlerts.createdAt, since)))
    .groupBy(sql`date(${impersonationAlerts.createdAt}, 'unixepoch')`);
  const byDate = new Map(rows.map((r) => [r.statDate, r.count]));
  const series = dateRange(days).map((date) => ({ statDate: date, count: byDate.get(date) ?? 0 }));
  return { series };
}

async function resolveScamProtectTrend(guildId: string, days: number) {
  const { configManager } = await import("../config/manager.js");
  const { pluginEnabled } = await import("../core/pluginCommand.js");
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  if (!pluginEnabled(guildConfig, "scam_protect")) return null;

  const { listScamProtectCatchesByDay } = await import("../plugins/scam_protect/functions/stats.js");
  // listScamProtectCatchesByDay has no "all time" mode of its own; 30 days is its own default and
  // matches automod's own hard retention window, a reasonable cap for this supplementary trend.
  const series = await listScamProtectCatchesByDay(guildId, days > 0 ? Math.min(days, 30) : 30);
  return { series };
}
