import type { TeamPeriodKind, TeamWeekStart } from "../../../config/schemas/teamControl.js";

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A quota/report period. `end` is exclusive (the next period's start). */
export type PeriodRange = { kind: TeamPeriodKind; start: Date; end: Date };

/** The bridge's TeamPeriod: ISO bounds (end is the period's last millisecond) and a label. */
export type TeamPeriod = { kind: TeamPeriodKind; start: string; end: string; label: string };

export type PeriodWhich = "current" | "previous";

function utcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Start of the week containing `ms` (00:00 UTC on Monday or Sunday). */
export function weekStartOf(ms: number, weekStart: TeamWeekStart): number {
  const day = utcMidnight(ms);
  const dow = new Date(day).getUTCDay(); // 0 = Sunday
  const back = weekStart === "sunday" ? dow : (dow + 6) % 7;
  return day - back * DAY_MS;
}

// Fortnights are counted from a fixed first week so every server's biweekly periods line up:
// Monday 5 January 1970, or Sunday 4 January 1970.
const BIWEEKLY_ANCHOR: Record<TeamWeekStart, number> = { monday: Date.UTC(1970, 0, 5), sunday: Date.UTC(1970, 0, 4) };

/** The period containing `now`, or the one before it. */
export function periodRange(kind: TeamPeriodKind, weekStart: TeamWeekStart, which: PeriodWhich = "current", now = Date.now()): PeriodRange {
  let start: number;
  let end: number;
  if (kind === "monthly") {
    const d = new Date(now);
    const offset = which === "previous" ? -1 : 0;
    start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1);
    end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset + 1, 1);
  } else if (kind === "biweekly") {
    const anchor = BIWEEKLY_ANCHOR[weekStart];
    const span = 14 * DAY_MS;
    const index = Math.floor((weekStartOf(now, weekStart) - anchor) / span) - (which === "previous" ? 1 : 0);
    start = anchor + index * span;
    end = start + span;
  } else {
    start = weekStartOf(now, weekStart) - (which === "previous" ? 7 * DAY_MS : 0);
    end = start + 7 * DAY_MS;
  }
  return { kind, start: new Date(start), end: new Date(end) };
}

function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "Week of Nov 2", "Nov 2 – Nov 15", "November 2026". */
export function periodLabel(range: PeriodRange): string {
  const start = range.start.getTime();
  if (range.kind === "monthly") {
    const d = new Date(start);
    return `${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  if (range.kind === "weekly") return `Week of ${shortDate(start)}`;
  return `${shortDate(start)} – ${shortDate(range.end.getTime() - DAY_MS)}`;
}

export function toTeamPeriod(range: PeriodRange): TeamPeriod {
  return {
    kind: range.kind,
    start: range.start.toISOString(),
    end: new Date(range.end.getTime() - 1).toISOString(),
    label: periodLabel(range),
  };
}

/** How much of [from, to) the span [spanStart, spanEnd) covers, 0-1. */
export function overlapFraction(spanStart: number, spanEnd: number, from: number, to: number): number {
  if (to <= from) return 0;
  const overlap = Math.max(0, Math.min(spanEnd, to) - Math.max(spanStart, from));
  return overlap / (to - from);
}

/** YYYY-MM-DD (UTC). */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Every UTC day in [from, to), oldest first. */
export function daysIn(from: number, to: number): string[] {
  const out: string[] = [];
  for (let day = utcMidnight(from); day < to; day += DAY_MS) out.push(dayKey(day));
  return out;
}

export function parseWhich(value: unknown): PeriodWhich {
  return value === "previous" ? "previous" : "current";
}
