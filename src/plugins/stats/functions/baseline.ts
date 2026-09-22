/**
 * Statistical primitives underneath every insight in insights.ts — a second, complementary tool
 * to analyzeSeries()/computeServerPulse() in analysis.ts (which stay as-is for the existing
 * per-window trend fields). Where analyzeSeries answers "did this window trend up or down", this
 * answers "how does the current window compare to the server's own normal range, and is that
 * difference big enough to be worth surfacing as an insight rather than noise".
 */

export type BaselineResult = {
  currentMean: number;
  currentTotal: number;
  baselineMean: number;
  baselineStdev: number;
  /** Standard-score of the current window's mean against the baseline distribution. */
  z: number;
  /** Percentage change of currentMean vs baselineMean. 100 when baseline was zero and current
   *  isn't; 0 when both are zero. */
  deltaPct: number;
};

/** Floor under baselineStdev so a metric with zero natural variance (e.g. every baseline day had
 *  exactly the same count) doesn't produce a division-by-near-zero, wildly inflated z-score. */
const STDEV_EPSILON = 0.5;

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

function stdev(values: number[], m: number): number {
  if (values.length === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Splits a full `[baseline...][current]` series (oldest → newest, `dates` and `values` the same
 * length) into a trailing "current" window of `compareWindowDays` and everything before it, up to
 * `baselineHorizonDays` (default `max(28, compareWindowDays * 4)`, naturally capped by however much
 * history is actually in `values`/`dates`). Returns null if there isn't at least one full current
 * window's worth of baseline data — callers should treat that as "not enough history yet", never
 * fabricate a comparison from a short baseline.
 */
export function computeBaseline(
  values: number[],
  dates: string[],
  compareWindowDays: number,
  baselineHorizonDays?: number,
): BaselineResult | null {
  if (values.length !== dates.length || values.length === 0) return null;
  if (values.length < compareWindowDays) return null;

  const current = values.slice(values.length - compareWindowDays);
  const beforeCurrent = values.slice(0, values.length - compareWindowDays);

  const horizon = baselineHorizonDays ?? Math.max(28, compareWindowDays * 4);
  const baselineValues = beforeCurrent.slice(Math.max(0, beforeCurrent.length - horizon));
  if (baselineValues.length < compareWindowDays) return null;

  const currentMean = mean(current);
  const currentTotal = current.reduce((sum, v) => sum + v, 0);
  const baselineMean = mean(baselineValues);
  const baselineStdev = stdev(baselineValues, baselineMean);

  const z = (currentMean - baselineMean) / Math.max(baselineStdev, STDEV_EPSILON);
  const deltaPct = baselineMean === 0 ? (currentMean > 0 ? 100 : 0) : ((currentMean - baselineMean) / baselineMean) * 100;

  return { currentMean, currentTotal, baselineMean, baselineStdev, z, deltaPct };
}

/**
 * Same idea as computeBaseline, but bucketed by weekday first (via each date's UTC weekday) before
 * comparing — so a quiet Saturday isn't flagged as anomalous relative to a busy Tuesday's normal.
 * `values`/`dates` should be the full available history (as long as practical); returns one
 * BaselineResult per date, comparing that date's value against the trailing same-weekday average
 * (excluding the date itself), or null for a date without at least `minSameWeekdaySamples` prior
 * same-weekday observations.
 */
export function computeWeekdayAdjustedBaseline(
  values: number[],
  dates: string[],
  minSameWeekdaySamples = 3,
): Array<{ date: string; value: number; z: number; deltaPct: number } | null> {
  if (values.length !== dates.length) return [];

  const byWeekdayHistory: number[][] = Array.from({ length: 7 }, () => []);
  const results: Array<{ date: string; value: number; z: number; deltaPct: number } | null> = [];

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i]!;
    const value = values[i]!;
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const priorSameWeekday = byWeekdayHistory[weekday]!;

    if (priorSameWeekday.length < minSameWeekdaySamples) {
      results.push(null);
    } else {
      const m = mean(priorSameWeekday);
      const sd = stdev(priorSameWeekday, m);
      const z = (value - m) / Math.max(sd, STDEV_EPSILON);
      const deltaPct = m === 0 ? (value > 0 ? 100 : 0) : ((value - m) / m) * 100;
      results.push({ date, value, z, deltaPct });
    }

    priorSameWeekday.push(value);
  }

  return results;
}

export type InsightWorthinessInput = {
  z: number;
  deltaPct: number;
  currentTotal: number;
  minVolumeFloor: number;
  /** Defaults tuned for weekly/monthly-scale window comparisons; unusual-day detection passes its
   *  own tighter z threshold (2.5) directly. */
  minAbsZ?: number;
  minAbsDeltaPct?: number;
};

/**
 * The single gate every insight generator must pass before it's allowed to surface — three
 * independent conditions (statistical / magnitude / volume) so a near-empty server's noise never
 * becomes a headline, and so a huge z-score on a naturally low-variance metric doesn't dominate on
 * its own. All three must hold.
 */
export function isInsightWorthy(input: InsightWorthinessInput): boolean {
  const minAbsZ = input.minAbsZ ?? 1.5;
  const minAbsDeltaPct = input.minAbsDeltaPct ?? 15;
  return (
    Math.abs(input.z) >= minAbsZ &&
    Math.abs(input.deltaPct) >= minAbsDeltaPct &&
    input.currentTotal >= input.minVolumeFloor
  );
}
