/**
 * Schedule math for Message Kits: when a schedule runs next, in the schedule's own IANA time zone.
 * Pure (Intl only), so DST and month-length rules are unit tested.
 *
 * - Local times that don't exist (the hour skipped when clocks go forward) run at the first moment
 *   after the gap (02:30 → 03:30). Local times that happen twice (clocks going back) run the first time.
 * - A monthly day past the end of the month runs on the month's last day (31 → 30 April, 28/29 February).
 */

export const SCHEDULE_REPEATS = ["none", "daily", "weekly", "monthly"] as const;
export type ScheduleRepeat = (typeof SCHEDULE_REPEATS)[number];

export type ScheduleRule = {
  repeat: ScheduleRepeat;
  /** "HH:MM", 24-hour. */
  timeOfDay: string;
  timezone: string;
  /** 0 = Sunday … 6 = Saturday (weekly). */
  weekday?: number | null;
  /** 1-31 (monthly). */
  monthDay?: number | null;
  /** "YYYY-MM-DD" (repeat none). */
  date?: string | null;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    // Bounded: there are only a few hundred zones, but don't let junk input grow this forever.
    if (formatters.size > 500) formatters.clear();
    formatters.set(timezone, formatter);
  }
  return formatter;
}

export function isValidTimezone(timezone: string): boolean {
  if (!timezone || typeof timezone !== "string" || timezone.length > 64) return false;
  try {
    formatterFor(timezone).format(0);
    return true;
  } catch {
    return false;
  }
}

export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value ?? "");
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

export function parseDateOnly(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** The wall-clock fields of an instant in `timezone`. */
export function zonedParts(instant: number, timezone: string) {
  const parts = formatterFor(timezone).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** How far `timezone` is ahead of UTC at `instant`, in ms. */
export function zoneOffsetMs(instant: number, timezone: string): number {
  const p = zonedParts(instant, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant a wall-clock time happens in `timezone` (see the DST notes above). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string): number {
  const local = Date.UTC(year, month - 1, day, hour, minute);
  const first = zoneOffsetMs(local, timezone);
  let instant = local - first;
  const second = zoneOffsetMs(instant, timezone);
  if (second !== first) {
    const retry = local - second;
    // Same offset both ways round = a real local time; otherwise it's in a gap and `instant`
    // (computed with the pre-gap offset) already lands just after it.
    if (zoneOffsetMs(retry, timezone) === second) instant = retry;
  }
  return instant;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Calendar arithmetic on a local date (no time zone involved). */
function addDays(date: { year: number; month: number; day: number }, days: number) {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export type ScheduleCheck = { ok: true } | { ok: false; field: string; error: string };

/** Checks a rule's fields (not whether a one-off time is in the future). */
export function checkScheduleRule(rule: ScheduleRule): ScheduleCheck {
  if (!SCHEDULE_REPEATS.includes(rule.repeat)) return { ok: false, field: "repeat", error: "repeat must be none, daily, weekly or monthly." };
  if (!parseTimeOfDay(rule.timeOfDay)) return { ok: false, field: "timeOfDay", error: "Use a 24-hour time like 09:30." };
  if (!isValidTimezone(rule.timezone)) return { ok: false, field: "timezone", error: "That time zone isn't recognised (use one like Europe/London)." };
  if (rule.repeat === "weekly" && !(Number.isInteger(rule.weekday) && rule.weekday! >= 0 && rule.weekday! <= 6))
    return { ok: false, field: "weekday", error: "Pick a day of the week." };
  if (rule.repeat === "monthly" && !(Number.isInteger(rule.monthDay) && rule.monthDay! >= 1 && rule.monthDay! <= 31))
    return { ok: false, field: "monthDay", error: "Pick a day of the month (1-31)." };
  if (rule.repeat === "none" && !parseDateOnly(rule.date ?? "")) return { ok: false, field: "date", error: "Pick a date." };
  return { ok: true };
}

/**
 * The next time the rule runs strictly after `after` (ms). One-off rules return their single time
 * whether or not it's past (callers reject past ones), or null when the fields are invalid.
 */
export function nextRunAt(rule: ScheduleRule, after: number): number | null {
  if (!checkScheduleRule(rule).ok) return null;
  const { hour, minute } = parseTimeOfDay(rule.timeOfDay)!;
  const tz = rule.timezone;

  if (rule.repeat === "none") {
    const date = parseDateOnly(rule.date!)!;
    return zonedTimeToUtc(date.year, date.month, date.day, hour, minute, tz);
  }

  const now = zonedParts(after, tz);
  const today = { year: now.year, month: now.month, day: now.day };

  if (rule.repeat === "daily" || rule.repeat === "weekly") {
    // Start a day early so a time zone ahead of the server's clock can't skip today.
    for (let offset = -1; offset <= 8; offset++) {
      const date = addDays(today, offset);
      if (rule.repeat === "weekly") {
        const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
        if (weekday !== rule.weekday) continue;
      }
      const at = zonedTimeToUtc(date.year, date.month, date.day, hour, minute, tz);
      if (at > after) return at;
    }
    return null;
  }

  // Monthly: this month (or last, for the same reason as above), then the following ones.
  for (let offset = -1; offset <= 13; offset++) {
    const index = today.year * 12 + (today.month - 1) + offset;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    const day = Math.min(rule.monthDay!, daysInMonth(year, month));
    const at = zonedTimeToUtc(year, month, day, hour, minute, tz);
    if (at > after) return at;
  }
  return null;
}
