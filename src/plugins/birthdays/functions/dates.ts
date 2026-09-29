import { resolveTimezoneInput } from "../../utility/functions/time.js";

/** Pure date helpers for Birthdays: no Discord or database access, so they're easy to test. */

export type Birthday = { month: number; day: number; year: number | null };
export type LeapDayMode = "feb28" | "mar1";
export type LocalMoment = { year: number; month: number; day: number; minutes: number };

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Whether a month/day (and optional year) is a real date. 29 February needs a leap year only when
 *  a year is given. */
export function isValidBirthday(month: number, day: number, year: number | null = null): boolean {
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1 || day > DAYS_IN_MONTH[month - 1]!) return false;
  if (year !== null && month === 2 && day === 29 && !isLeapYear(year)) return false;
  return true;
}

/** "14 March" style label, with the year when known and asked for. */
export function formatBirthday(birthday: Birthday, withYear = false): string {
  const base = `${birthday.day} ${MONTH_NAMES[birthday.month - 1]}`;
  return withYear && birthday.year ? `${base} ${birthday.year}` : base;
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** The age someone turns on their birthday in `celebrationYear`, or null without a birth year. */
export function ageOn(birthday: Birthday, celebrationYear: number): number | null {
  if (!birthday.year) return null;
  const age = celebrationYear - birthday.year;
  return age > 0 && age < 150 ? age : null;
}

/** The calendar day a birthday falls on in a given year (29 February moves in other years). */
export function observedDate(birthday: Birthday, year: number, leapDay: LeapDayMode): { month: number; day: number } {
  if (birthday.month === 2 && birthday.day === 29 && !isLeapYear(year)) {
    return leapDay === "mar1" ? { month: 3, day: 1 } : { month: 2, day: 28 };
  }
  return { month: birthday.month, day: birthday.day };
}

/** Offset from UTC in minutes for a timezone setting (IANA, abbreviation or GMT+5 style), or UTC. */
export function timezoneOffsetMinutes(timezone: string | null | undefined, at: Date): number {
  return resolveTimezoneInput(timezone ?? "UTC", at)?.offsetMinutes ?? 0;
}

/** The wall-clock date and time in a timezone at an instant. */
export function localMoment(at: Date, timezone: string | null | undefined): LocalMoment {
  const local = new Date(at.getTime() + timezoneOffsetMinutes(timezone, at) * 60_000);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

/** "HH:MM" to minutes after midnight (falls back to midnight for anything malformed). */
export function timeToMinutes(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return 0;
  return Math.min(23, Number(match[1])) * 60 + Math.min(59, Number(match[2]));
}

/** Whether `now` (as a local moment) is on the birthday and at or after the celebration time. */
export function isCelebrationDue(birthday: Birthday, now: LocalMoment, celebrateAtMinutes: number, leapDay: LeapDayMode): boolean {
  const observed = observedDate(birthday, now.year, leapDay);
  return observed.month === now.month && observed.day === now.day && now.minutes >= celebrateAtMinutes;
}

/** Whole days from a local date until the next time the birthday comes round (0 = today). */
export function daysUntilBirthday(birthday: Birthday, today: LocalMoment, leapDay: LeapDayMode): number {
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  for (const year of [today.year, today.year + 1]) {
    const observed = observedDate(birthday, year, leapDay);
    const when = Date.UTC(year, observed.month - 1, observed.day);
    if (when >= todayUtc) return Math.round((when - todayUtc) / 86_400_000);
  }
  return 365;
}

/** The moment the birthday is next celebrated (today's, even if it already started), for Discord
 *  timestamps. Wall-clock time in the timezone is converted twice so DST changes land right. */
export function nextCelebrationAt(
  birthday: Birthday,
  now: Date,
  timezone: string | null | undefined,
  celebrateAtMinutes: number,
  leapDay: LeapDayMode,
): Date {
  const today = localMoment(now, timezone);
  const days = daysUntilBirthday(birthday, today, leapDay);
  const wallClock = Date.UTC(today.year, today.month - 1, today.day + days) + celebrateAtMinutes * 60_000;
  let instant = wallClock - timezoneOffsetMinutes(timezone, new Date(wallClock)) * 60_000;
  instant = wallClock - timezoneOffsetMinutes(timezone, new Date(instant)) * 60_000;
  return new Date(instant);
}
