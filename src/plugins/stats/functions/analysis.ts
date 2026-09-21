import { defaultTranslator, type Translator } from "../../../i18n/index.js";

export type TrendDirection = "up" | "down" | "stable";

export type SeriesAnalysis = {
  total: number;
  average: number;
  peakValue: number;
  peakIndex: number;
  activeDays: number;
  trend: TrendDirection;
  trendPct: number;
  weekdayTotals: number[];
  busiestWeekday: number;
};

function weekdayNames(t: Translator): string[] {
  return [
    t("stats.weekdaySun", "Sun"),
    t("stats.weekdayMon", "Mon"),
    t("stats.weekdayTue", "Tue"),
    t("stats.weekdayWed", "Wed"),
    t("stats.weekdayThu", "Thu"),
    t("stats.weekdayFri", "Fri"),
    t("stats.weekdaySat", "Sat"),
  ];
}

export function weekdayName(index: number, t: Translator = defaultTranslator): string {
  return weekdayNames(t)[index] ?? "?";
}

export function analyzeSeries(values: number[], dates: string[]): SeriesAnalysis {
  const total = values.reduce((sum, v) => sum + v, 0);
  const average = values.length ? total / values.length : 0;
  let peakValue = 0;
  let peakIndex = 0;
  let activeDays = 0;
  const weekdayTotals = Array.from({ length: 7 }, () => 0);

  values.forEach((value, i) => {
    if (value > peakValue) {
      peakValue = value;
      peakIndex = i;
    }
    if (value > 0) activeDays += 1;
    const date = dates[i];
    if (date) {
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      weekdayTotals[weekday]! += value;
    }
  });

  const midpoint = Math.floor(values.length / 2);
  const first = values.slice(0, midpoint);
  const second = values.slice(midpoint);
  const firstAvg = first.length ? first.reduce((s, v) => s + v, 0) / first.length : 0;
  const secondAvg = second.length ? second.reduce((s, v) => s + v, 0) / second.length : 0;
  const trendPct = firstAvg === 0 ? (secondAvg > 0 ? 100 : 0) : ((secondAvg - firstAvg) / firstAvg) * 100;
  const trend: TrendDirection = Math.abs(trendPct) < 8 ? "stable" : trendPct > 0 ? "up" : "down";

  let busiestWeekday = 0;
  weekdayTotals.forEach((totalForDay, i) => {
    if (totalForDay > weekdayTotals[busiestWeekday]!) busiestWeekday = i;
  });

  return {
    total,
    average,
    peakValue,
    peakIndex,
    activeDays,
    trend,
    trendPct,
    weekdayTotals,
    busiestWeekday,
  };
}

export function formatTrend(trend: TrendDirection, trendPct: number, t: Translator = defaultTranslator): string {
  const abs = Math.abs(Math.round(trendPct));
  if (trend === "stable") return t("stats.trendStable", "Stable (~{pct}% change)", { pct: abs });
  if (trend === "up") return t("stats.trendUp", "Up **{pct}%** vs earlier period", { pct: abs });
  return t("stats.trendDown", "Down **{pct}%** vs earlier period", { pct: abs });
}

/** Percentage of tracked traffic (0–100). */
export function sharePctValue(part: number, whole: number): number {
  if (whole <= 0 || part <= 0) return 0;
  return (part / whole) * 100;
}

export function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${sharePctValue(part, whole).toFixed(1)}%`;
}

/** Rounded share label for leaderboard display (e.g. 33% for a third). */
export function formatSharePct(part: number, whole: number): string {
  const value = sharePctValue(part, whole);
  if (value <= 0) return "0%";
  if (value >= 10) return `${Math.round(value)}%`;
  return `${value.toFixed(1)}%`;
}

export type ServerPulseInput = { key: string; trend: TrendDirection; trendPct: number };

export type ServerPulse = {
  direction: "up" | "down" | "mixed" | "stable";
  drivers: string[];
};

/**
 * Rolls up a handful of already-computed trend analyses (messages, active users, engagement,
 * moderation load, etc.) into one composite "is the server up or down right now" summary. Pure
 * function, no DB access; callers pass in whichever `{ key, trend, trendPct }` triples they
 * want represented.
 */
export function computeServerPulse(analyses: ServerPulseInput[]): ServerPulse {
  if (analyses.length === 0) return { direction: "stable", drivers: [] };

  const nonStable = analyses.filter((a) => a.trend !== "stable");
  if (nonStable.length === 0) return { direction: "stable", drivers: [] };

  const upCount = nonStable.filter((a) => a.trend === "up").length;
  const downCount = nonStable.filter((a) => a.trend === "down").length;

  const rankedByMagnitude = [...nonStable].sort((a, b) => Math.abs(b.trendPct) - Math.abs(a.trendPct));
  const topDrivers = rankedByMagnitude.slice(0, 2).map((a) => a.key);

  // "Roughly evenly split": neither direction has a clear majority of the moving metrics.
  const total = upCount + downCount;
  const majorityShare = Math.max(upCount, downCount) / total;
  if (majorityShare < 0.65) {
    return { direction: "mixed", drivers: topDrivers };
  }

  return { direction: upCount > downCount ? "up" : "down", drivers: topDrivers };
}
