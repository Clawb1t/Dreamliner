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

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function weekdayName(index: number): string {
  return WEEKDAY_NAMES[index] ?? "?";
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

export function formatTrend(trend: TrendDirection, trendPct: number): string {
  const abs = Math.abs(Math.round(trendPct));
  if (trend === "stable") return `Stable (~${abs}% change)`;
  if (trend === "up") return `Up **${abs}%** vs earlier period`;
  return `Down **${abs}%** vs earlier period`;
}

export function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/** Rounded share label for leaderboard display (e.g. 33% for a third). */
export function formatSharePct(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return "0%";
  const value = (part / whole) * 100;
  if (value >= 10) return `${Math.round(value)}%`;
  if (value >= 1) return `${value.toFixed(1)}%`;
  return `${value.toFixed(1)}%`;
}
