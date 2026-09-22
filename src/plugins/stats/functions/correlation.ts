/**
 * Real pairwise correlation between the server's own daily metrics — messages, joins, leaves,
 * voice minutes, moderation cases, automod hits, command uses — all already tracked, just never
 * compared against each other before. Every number here is computed from the same daily rollup
 * tables the rest of the stats page reads (getFilledDailyStats/getFilledVoiceDailyStats/
 * getFilledModCaseDaily/getFilledAutomodHitDaily/getFilledGuildCommandDailyUses); this module adds
 * no new tracking, only a new calculation (Pearson correlation) over data that already exists.
 */
import { getFilledDailyStats, isAllTimeWindow } from "./daily.js";
import { getFilledVoiceDailyStats } from "./voice.js";
import { getFilledModCaseDaily, getFilledAutomodHitDaily } from "./moderationStats.js";
import { getFilledGuildCommandDailyUses } from "./commandUsage.js";

export type MetricKey =
  | "messages"
  | "joins"
  | "leaves"
  | "voiceMinutes"
  | "modCases"
  | "automodHits"
  | "commands";

export const METRIC_LABELS: Record<MetricKey, string> = {
  messages: "Messages",
  joins: "Joins",
  leaves: "Leaves",
  voiceMinutes: "Voice minutes",
  modCases: "Moderation cases",
  automodHits: "Automod hits",
  commands: "Command uses",
};

export type CorrelationPoint = { date: string; x: number; y: number };

export type CorrelationPair = {
  metricA: MetricKey;
  metricB: MetricKey;
  /** Pearson correlation coefficient, -1..1. Null when either series has no variance (every day
   *  the same value) or there are fewer than MIN_POINTS days of overlapping data — a correlation
   *  computed from that isn't meaningful and must not be presented as a real number. */
  r: number | null;
  n: number;
  strength: "strong" | "moderate" | "weak" | "none" | "insufficient_data";
  points: CorrelationPoint[];
};

const MIN_POINTS = 8;

/**
 * The pairs worth asking about, not every combination of the 7 metrics (21 pairs, most of them
 * meaningless — e.g. voice minutes vs command uses has no plausible causal or confounding story).
 * Each pair here has a real reason someone would ask "does X move with Y".
 */
const CURATED_PAIRS: Array<[MetricKey, MetricKey]> = [
  ["messages", "joins"],
  ["messages", "leaves"],
  ["messages", "voiceMinutes"],
  ["messages", "commands"],
  ["messages", "automodHits"],
  ["joins", "modCases"],
  ["leaves", "modCases"],
  ["modCases", "automodHits"],
];

export function pearson(x: number[], y: number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < MIN_POINTS) return null;

  const meanX = x.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const meanY = y.slice(0, n).reduce((s, v) => s + v, 0) / n;

  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - meanX;
    const dy = y[i]! - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  if (varX === 0 || varY === 0) return null;
  return cov / Math.sqrt(varX * varY);
}

export function strengthOf(r: number | null): CorrelationPair["strength"] {
  if (r == null) return "insufficient_data";
  const abs = Math.abs(r);
  if (abs >= 0.6) return "strong";
  if (abs >= 0.35) return "moderate";
  if (abs >= 0.15) return "weak";
  return "none";
}

/**
 * Correlates the server's own daily metrics against each other over the window, using the exact
 * same day-count convention (StatsWindow) as everywhere else. Automod hits are only ever available
 * for the last 30 days (hard-pruned elsewhere), so pairs involving automodHits are naturally
 * bounded to whatever overlap exists within that.
 */
export async function getMetricCorrelations(guildId: string, days: number): Promise<CorrelationPair[]> {
  const effectiveDays = isAllTimeWindow(days) ? 90 : days;

  const [daily, voiceDaily, caseDaily, automodDaily, commandDaily] = await Promise.all([
    getFilledDailyStats(guildId, effectiveDays),
    getFilledVoiceDailyStats(guildId, effectiveDays),
    getFilledModCaseDaily(guildId, effectiveDays),
    getFilledAutomodHitDaily(guildId, effectiveDays),
    getFilledGuildCommandDailyUses(guildId, effectiveDays),
  ]);

  const voiceByDate = new Map(voiceDaily.map((r) => [r.statDate, r.minutes]));
  const caseByDate = new Map(caseDaily.map((r) => [r.statDate, r.total]));
  const automodByDate = new Map(automodDaily.map((r) => [r.statDate, r.hits]));
  const commandByDate = new Map(commandDaily.map((r) => [r.statDate, r.uses]));

  const byDate = new Map<string, Record<MetricKey, number>>();
  for (const row of daily) {
    byDate.set(row.statDate, {
      messages: row.messages,
      joins: row.joins,
      leaves: row.leaves,
      voiceMinutes: voiceByDate.get(row.statDate) ?? 0,
      modCases: caseByDate.get(row.statDate) ?? 0,
      automodHits: automodByDate.get(row.statDate) ?? 0,
      commands: commandByDate.get(row.statDate) ?? 0,
    });
  }

  const dates = [...byDate.keys()].sort();

  return CURATED_PAIRS.map(([metricA, metricB]) => {
    // automodHits only has real data for the last 30 days (its own hard retention) — dates
    // outside that are genuinely zero (see getFilledAutomodHitDaily), which is correct to include
    // as real zeros, not a gap, so no special-casing needed here beyond what's already zero-filled.
    const points: CorrelationPoint[] = dates.map((date) => {
      const row = byDate.get(date)!;
      return { date, x: row[metricA], y: row[metricB] };
    });

    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const r = pearson(xs, ys);

    return {
      metricA,
      metricB,
      r: r != null ? Number(r.toFixed(3)) : null,
      n: points.length,
      strength: strengthOf(r),
      points,
    };
  });
}
