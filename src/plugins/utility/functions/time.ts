import * as chrono from "chrono-node";
import type { AutocompleteInteraction } from "discord.js";

export type ResolvedTimezone = {
  /** Offset from UTC in minutes (positive = ahead of UTC), resolved at a specific instant. */
  offsetMinutes: number;
  /** Short human label shown back to the user, e.g. "UTC", "GMT+5:30", "EST (UTC-5)". */
  label: string;
  /** IANA zone name, when the input resolved to one — lets previews show real, DST-aware wall time. */
  iana?: string;
};

/** Common non-IANA "GMT style" zone abbreviations, mapped to a representative IANA zone so DST
 * is resolved from the real calendar instead of a single hard-coded offset per name (EST/EDT
 * both map here; which one actually applies falls out of `offsetMinutesForIana` at the given
 * instant). Deliberately not exhaustive — just the ones people actually type. */
const ABBREVIATION_ZONES: Record<string, string> = {
  UTC: "UTC",
  GMT: "UTC",
  EST: "America/New_York",
  EDT: "America/New_York",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  MST: "America/Denver",
  MDT: "America/Denver",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  AST: "America/Halifax",
  ADT: "America/Halifax",
  BST: "Europe/London",
  WET: "Europe/Lisbon",
  WEST: "Europe/Lisbon",
  CET: "Europe/Paris",
  CEST: "Europe/Paris",
  EET: "Europe/Helsinki",
  EEST: "Europe/Helsinki",
  MSK: "Europe/Moscow",
  IST: "Asia/Kolkata",
  PKT: "Asia/Karachi",
  ICT: "Asia/Bangkok",
  SGT: "Asia/Singapore",
  HKT: "Asia/Hong_Kong",
  JST: "Asia/Tokyo",
  KST: "Asia/Seoul",
  AEST: "Australia/Sydney",
  AEDT: "Australia/Sydney",
  ACST: "Australia/Adelaide",
  ACDT: "Australia/Adelaide",
  AWST: "Australia/Perth",
  NZST: "Pacific/Auckland",
  NZDT: "Pacific/Auckland",
};

/** An IANA zone's offset from UTC (in minutes) at a specific instant — the standard trick for
 * getting a DST-aware offset without a timezone-database dependency: format `at` into that
 * zone's wall-clock fields, re-interpret those same fields as UTC, and diff against `at`. */
function offsetMinutesForIana(zone: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(at);
    const map: Record<string, string> = {};
    for (const part of parts) map[part.type] = part.value;
    // Some engines report midnight as hour "24" rather than rolling the day over.
    const hour = map.hour === "24" ? 0 : Number(map.hour);
    const asUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      hour,
      Number(map.minute),
      Number(map.second),
    );
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return null;
  }
}

function formatOffset(totalMinutes: number): string {
  const sign = totalMinutes < 0 ? "-" : "+";
  const abs = Math.abs(totalMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

/**
 * Resolves a user-supplied timezone into a fixed UTC offset (computed at `at`, so IANA zones and
 * known abbreviations get the correct DST-aware offset for that instant instead of a
 * permanently-wrong fixed number). Accepts, in order:
 * - Blank, "UTC", "GMT", or "Z" -> UTC
 * - A GMT-style signed offset: "GMT+5", "UTC-8", "+5:30", "-0530"
 * - A common zone abbreviation: "EST", "PST", "JST", "IST", "AEST", ...
 * - A full IANA name: "America/New_York", "Europe/London", ...
 * Returns `null` for anything unrecognised.
 */
export function resolveTimezoneInput(
  raw: string | null | undefined,
  at: Date = new Date(),
): ResolvedTimezone | null {
  const input = (raw ?? "").trim();
  if (!input || /^(utc|gmt|z)$/i.test(input)) {
    return { offsetMinutes: 0, label: "UTC", iana: "UTC" };
  }

  const stripped = input.replace(/\s+/g, "");
  const offsetMatch = /^(?:GMT|UTC)?([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(stripped);
  if (offsetMatch) {
    const sign = offsetMatch[1] === "-" ? -1 : 1;
    const hours = Number(offsetMatch[2]);
    const minutes = offsetMatch[3] ? Number(offsetMatch[3]) : 0;
    if (hours > 14 || minutes > 59) return null;
    const offsetMinutes = sign * (hours * 60 + minutes);
    return { offsetMinutes, label: `GMT${formatOffset(offsetMinutes)}` };
  }

  const abbreviation = ABBREVIATION_ZONES[input.toUpperCase()];
  if (abbreviation) {
    const offsetMinutes = offsetMinutesForIana(abbreviation, at);
    if (offsetMinutes == null) return null;
    return {
      offsetMinutes,
      label: `${input.toUpperCase()} (UTC${formatOffset(offsetMinutes)})`,
      iana: abbreviation,
    };
  }

  const offsetMinutes = offsetMinutesForIana(input, at);
  if (offsetMinutes == null) return null;
  return { offsetMinutes, label: `${input} (UTC${formatOffset(offsetMinutes)})`, iana: input };
}

export type ParsedWhen = { date: Date; matchedText: string };

/**
 * Parses the "when" option. Blank or "now" resolve instantly without going through chrono at
 * all; everything else is handed to chrono-node interpreted in `tz`'s offset, so an absolute,
 * timezone-naive moment like "3pm" or "2026-01-01 14:00" resolves against the *requested* zone's
 * wall clock rather than the bot process's own timezone. `forwardDate` is on, so a bare
 * weekday/time ("friday", "3pm") means the next occurrence instead of one that may already be in
 * the past — purely relative phrases ("10 days ago", "in 3 hours") are unaffected by that.
 */
export function parseWhenInput(
  raw: string | null | undefined,
  tz: ResolvedTimezone,
  now: Date = new Date(),
): ParsedWhen | null {
  const input = (raw ?? "").trim();
  if (!input || /^now$/i.test(input)) return { date: now, matchedText: "now" };

  const results = chrono.parse(input, { instant: now, timezone: tz.offsetMinutes }, { forwardDate: true });
  if (!results.length) return null;
  return { date: results[0]!.start.date(), matchedText: results[0]!.text };
}

export type DiscordTimestampStyle = "t" | "T" | "d" | "D" | "f" | "F" | "R";

export const TIMESTAMP_STYLES: DiscordTimestampStyle[] = ["t", "T", "d", "D", "f", "F", "R"];

export const TIMESTAMP_STYLE_LABELS: Record<DiscordTimestampStyle, string> = {
  t: "Short time",
  T: "Long time",
  d: "Short date",
  D: "Long date",
  f: "Short date/time",
  F: "Long date/time",
  R: "Relative",
};

export function discordTimestamp(date: Date, style: DiscordTimestampStyle): string {
  return `<t:${Math.round(date.getTime() / 1000)}:${style}>`;
}

// ---- Autocomplete -----------------------------------------------------

function formatAbsoluteHuman(date: Date, tz: ResolvedTimezone): string {
  if (tz.iana) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz.iana,
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  // A bare fixed offset (e.g. "GMT+5") isn't a valid Intl timeZone — shift the instant by the
  // offset by hand, then format the shifted instant as UTC to display those wall-clock fields.
  const shifted = new Date(date.getTime() + tz.offsetMinutes * 60_000);
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(shifted);
  return `${formatted} ${tz.label}`;
}

const RELATIVE_FORMAT = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const RELATIVE_UNITS: { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: "year", ms: 365 * 24 * 60 * 60_000 },
  { unit: "month", ms: 30 * 24 * 60 * 60_000 },
  { unit: "week", ms: 7 * 24 * 60 * 60_000 },
  { unit: "day", ms: 24 * 60 * 60_000 },
  { unit: "hour", ms: 60 * 60_000 },
  { unit: "minute", ms: 60_000 },
  { unit: "second", ms: 1_000 },
];

function formatRelativeHuman(date: Date, now: Date): string {
  const diffMs = date.getTime() - now.getTime();
  if (Math.abs(diffMs) < 10_000) return "now";
  for (const { unit, ms } of RELATIVE_UNITS) {
    if (Math.abs(diffMs) >= ms || unit === "second") {
      return RELATIVE_FORMAT.format(Math.round(diffMs / ms), unit);
    }
  }
  return "now";
}

function previewChoice(phrase: string, date: Date, tz: ResolvedTimezone, now: Date): { name: string; value: string } {
  const name = `${phrase} → ${formatAbsoluteHuman(date, tz)} (${formatRelativeHuman(date, now)})`;
  return { name: name.slice(0, 100), value: phrase.slice(0, 100) };
}

const PRESETS: { phrase: string; ms: number }[] = [
  { phrase: "now", ms: 0 },
  { phrase: "in 15 minutes", ms: 15 * 60_000 },
  { phrase: "in 1 hour", ms: 60 * 60_000 },
  { phrase: "in 3 hours", ms: 3 * 60 * 60_000 },
  { phrase: "tomorrow", ms: 24 * 60 * 60_000 },
  { phrase: "in 3 days", ms: 3 * 24 * 60 * 60_000 },
  { phrase: "in 1 week", ms: 7 * 24 * 60 * 60_000 },
  { phrase: "1 hour ago", ms: -60 * 60_000 },
  { phrase: "yesterday", ms: -24 * 60 * 60_000 },
  { phrase: "10 days ago", ms: -10 * 24 * 60 * 60_000 },
];

const NUMBER_UNITS: { unit: string; ms: number }[] = [
  { unit: "minutes", ms: 60_000 },
  { unit: "hours", ms: 60 * 60_000 },
  { unit: "days", ms: 24 * 60 * 60_000 },
  { unit: "weeks", ms: 7 * 24 * 60 * 60_000 },
];

const EXAMPLE_PHRASES = ["in 1 hour", "10 days ago", "tomorrow", "next friday 3pm", "2026-01-01 14:00"];

/**
 * Builds live autocomplete suggestions for the "when" option — a moving preview of what the
 * currently-typed text actually resolves to, rather than a fixed list of canned choices (what
 * Discord's own timestamp picker offers):
 * - Empty query: a handful of common presets ("in 1 hour", "tomorrow", "1 hour ago", ...).
 * - A bare number ("10"): every common unit x direction combo for that number, so "10" alone
 *   surfaces "in 10 minutes" through "10 weeks ago" without retyping anything.
 * - Anything chrono can parse: one suggestion previewing exactly what will be sent.
 * - Anything it can't (yet) parse: a few real, working examples instead of an empty dropdown.
 */
export function buildTimeAutocomplete(
  query: string,
  timezoneRaw: string | null | undefined,
  now: Date = new Date(),
): { name: string; value: string }[] {
  const tz = resolveTimezoneInput(timezoneRaw, now) ?? { offsetMinutes: 0, label: "UTC", iana: "UTC" };
  const trimmed = query.trim();

  if (!trimmed) {
    return PRESETS.map(({ phrase, ms }) => previewChoice(phrase, new Date(now.getTime() + ms), tz, now));
  }

  const bareNumber = /^\d{1,4}$/.exec(trimmed);
  if (bareNumber) {
    const n = Number(bareNumber[0]);
    const choices: { name: string; value: string }[] = [];
    for (const { unit, ms } of NUMBER_UNITS) {
      choices.push(previewChoice(`in ${n} ${unit}`, new Date(now.getTime() + n * ms), tz, now));
      choices.push(previewChoice(`${n} ${unit} ago`, new Date(now.getTime() - n * ms), tz, now));
    }
    return choices;
  }

  const parsed = parseWhenInput(trimmed, tz, now);
  if (parsed) {
    return [previewChoice(trimmed, parsed.date, tz, now)];
  }

  const examples: { name: string; value: string }[] = [];
  for (const example of EXAMPLE_PHRASES) {
    const result = parseWhenInput(example, tz, now);
    if (result) examples.push(previewChoice(example, result.date, tz, now));
  }
  return examples;
}

export async function handleTimeAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "when") {
    await interaction.respond([]);
    return;
  }
  const timezoneRaw = interaction.options.getString("timezone");
  const choices = buildTimeAutocomplete(String(focused.value ?? ""), timezoneRaw);
  await interaction.respond(choices);
}
