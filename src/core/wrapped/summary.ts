/** Pure helpers behind Wrapped's numbers (unit tested in wrapped.test.ts). */

export type Streak = { days: number; start: string; end: string };

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

/** Longest run of consecutive "YYYY-MM-DD" days. Input order and duplicates don't matter. */
export function longestStreak(dates: Iterable<string>): Streak | null {
  const days = [...new Set(dates)].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (days.length === 0) return null;
  let best: Streak = { days: 1, start: days[0]!, end: days[0]! };
  let runStart = days[0]!;
  let runLength = 1;
  for (let i = 1; i < days.length; i++) {
    if (dayNumber(days[i]!) - dayNumber(days[i - 1]!) === 1) {
      runLength += 1;
    } else {
      runStart = days[i]!;
      runLength = 1;
    }
    if (runLength > best.days) best = { days: runLength, start: runStart, end: days[i]! };
  }
  return best;
}

/** Totals per calendar month (index 0 = January) from per-day rows. */
export function monthlyTotals(rows: Iterable<{ date: string; value: number }>): number[] {
  const months = new Array(12).fill(0) as number[];
  for (const row of rows) {
    const month = Number(row.date.slice(5, 7)) - 1;
    if (month >= 0 && month < 12) months[month]! += row.value;
  }
  return months;
}

/** Totals per weekday, Monday first (index 0 = Monday, 6 = Sunday), from per-day rows (UTC dates). */
export function weekdayTotals(rows: Iterable<{ date: string; value: number }>): number[] {
  const days = new Array(7).fill(0) as number[];
  for (const row of rows) {
    const weekday = new Date(`${row.date}T00:00:00Z`).getUTCDay();
    if (Number.isNaN(weekday)) continue;
    days[(weekday + 6) % 7]! += row.value;
  }
  return days;
}

/** The biggest single day, earliest first on a tie. */
export function busiestDay(rows: Iterable<{ date: string; value: number }>): { date: string; value: number } | null {
  let best: { date: string; value: number } | null = null;
  for (const row of rows) {
    if (row.value <= 0) continue;
    if (!best || row.value > best.value || (row.value === best.value && row.date < best.date)) best = { date: row.date, value: row.value };
  }
  return best;
}

/**
 * "Top X%" among everyone with any messages that year: 1 + people strictly ahead, over everyone,
 * rounded up to a whole percent (never 0). Null when the pool is too small to say anything.
 */
export function topPercent(allTotals: readonly number[], mine: number, minPool = 5): number | null {
  if (mine <= 0 || allTotals.length < minPool) return null;
  let ahead = 0;
  for (const value of allTotals) if (value > mine) ahead += 1;
  return Math.max(1, Math.ceil(((ahead + 1) / allTotals.length) * 100));
}

/** Share of a total as a whole percent (0 when there's no total). */
export function sharePercent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

/**
 * The year as one character per day ("0" to "4"), 1 January first: 0 is no messages, 1 to 4 are
 * quartiles of the person's own active days. Drawn as the year grid on the Messages slide.
 */
export function yearHeatmap(year: number, rows: Iterable<{ date: string; value: number }>): string {
  const start = Date.UTC(year, 0, 1);
  const days = Math.round((Date.UTC(year + 1, 0, 1) - start) / DAY_MS);
  const values = new Array(days).fill(0) as number[];
  for (const row of rows) {
    const index = Math.round((Date.parse(`${row.date}T00:00:00Z`) - start) / DAY_MS);
    if (index >= 0 && index < days) values[index]! += row.value;
  }
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return "0".repeat(days);
  const cut = (q: number) => sorted[Math.floor(q * (sorted.length - 1))]!;
  const [q1, q2, q3] = [cut(0.25), cut(0.5), cut(0.75)];
  return values.map((v) => (v <= 0 ? "0" : v <= q1 ? "1" : v <= q2 ? "2" : v <= q3 ? "3" : "4")).join("");
}
