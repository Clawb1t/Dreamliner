import { createHash } from "node:crypto";
import { z } from "zod";
import { PLUGIN_DISPLAY } from "../helpCategories.js";

/**
 * Public changelog: the pure rules (no database, network or AI). Commits are grouped into release
 * windows, Autopilot rewrites each window into release notes, and everything it returns is validated
 * and cleaned here before it is stored or shown.
 */

/** Section icons. Each maps to one site icon (the website keeps the same list). */
export const CHANGELOG_ICONS = [
  "notifications",
  "hangar",
  "ghost",
  "leaderboard",
  "moderation",
  "community",
  "games",
  "commands",
  "dashboard",
  "music",
  "voice",
  "ai",
  "economy",
  "security",
  "performance",
  "tickets",
  "store",
  "roles",
  "spark",
] as const;
export type ChangelogIcon = (typeof CHANGELOG_ICONS)[number];

export const CHANGELOG_STATUSES = ["published", "draft", "hidden"] as const;
export type ChangelogStatus = (typeof CHANGELOG_STATUSES)[number];

/** One commit as the changelog keeps it. Never published: only Autopilot and operators see it. */
export type ChangelogCommit = {
  sha: string;
  /** ISO 8601 author date. */
  date: string;
  /** Full message (subject and body). */
  message: string;
  /** Product areas touched (plugin display names), derived from the changed files. */
  areas: string[] | null;
};

export type ChangelogWindow = {
  start: number;
  end: number;
  commits: ChangelogCommit[];
};

export type WindowOptions = {
  /** A quiet period longer than this closes a window. */
  gapHours: number;
  /** A window never spans more than this many days, even with no quiet period. */
  maxDays: number;
};

const HOUR = 3_600_000;

/** Defaults picked from the real history: 48h / 7 days reproduces the hand-written updates. */
export function windowOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): WindowOptions {
  const gap = Number(env.CHANGELOG_WINDOW_GAP_HOURS);
  const max = Number(env.CHANGELOG_WINDOW_MAX_DAYS);
  return {
    gapHours: Number.isFinite(gap) && gap >= 1 && gap <= 24 * 30 ? gap : 48,
    maxDays: Number.isFinite(max) && max >= 1 && max <= 60 ? max : 7,
  };
}

export function commitTime(commit: Pick<ChangelogCommit, "date">): number {
  const t = Date.parse(commit.date);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Groups commits into release windows: consecutive commits stay together until there is a quiet
 * gap longer than `gapHours`, or the window would span more than `maxDays`.
 */
export function groupCommitsIntoWindows(commits: ChangelogCommit[], options: WindowOptions): ChangelogWindow[] {
  const sorted = [...commits].sort((a, b) => commitTime(a) - commitTime(b));
  const windows: ChangelogWindow[] = [];
  for (const commit of sorted) {
    const t = commitTime(commit);
    const current = windows.at(-1);
    if (!current || t - current.end > options.gapHours * HOUR || t - current.start > options.maxDays * 24 * HOUR) {
      windows.push({ start: t, end: t, commits: [commit] });
    } else {
      current.end = t;
      current.commits.push(commit);
    }
  }
  return windows;
}

/** A window is finished once a later window has started, or nothing has landed for `gapHours`. */
export function isWindowClosed(window: ChangelogWindow, isLast: boolean, now: number, options: WindowOptions): boolean {
  if (!isLast) return true;
  return now - window.end > options.gapHours * HOUR;
}

/** Stable identity of a set of commits: the idempotency key for generation. */
export function commitSetKey(shas: string[]): string {
  return createHash("sha256").update([...shas].sort().join("\n")).digest("hex").slice(0, 32);
}

// --- Dates, slugs and titles --------------------------------------------------------------

const LONDON_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function londonParts(ms: number): { day: string; month: string; year: string } {
  const parts = Object.fromEntries(LONDON_PARTS.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { day: parts.day ?? "01", month: parts.month ?? "01", year: parts.year ?? "1970" };
}

/** "20/11/2026", the owner's date format (UK time). */
export function formatUpdateDate(ms: number): string {
  const { day, month, year } = londonParts(ms);
  return `${day}/${month}/${year}`;
}

/** "2026-11-20": the update's URL slug (before any de-duplicating suffix). */
export function baseSlug(ms: number): string {
  const { day, month, year } = londonParts(ms);
  return `${year}-${month}-${day}`;
}

export function uniqueSlug(ms: number, taken: (slug: string) => boolean): string {
  const base = baseSlug(ms);
  if (!taken(base)) return base;
  for (let i = 2; i < 100; i++) {
    if (!taken(`${base}-${i}`)) return `${base}-${i}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "Dreamliner Update 20/11/2026 - Notifications, Ghost Mode, The Hangar and more". */
export function buildUpdateTitle(windowEnd: number, headline: string[], hasMore: boolean): string {
  const date = formatUpdateDate(windowEnd);
  const all = headline.filter(Boolean);
  const names = all.slice(0, 3);
  if (!names.length) return `Dreamliner Update ${date}`;
  const list = hasMore || all.length > names.length ? `${names.join(", ")} and more` : joinNames(names);
  return `Dreamliner Update ${date} - ${list}`;
}

// --- Cleaning and validating Autopilot output ---------------------------------------------

/**
 * Plain web text in UK spelling: no em or en dashes (a spaced dash becomes a comma), no emoji, no Discord markdown
 * or :emoji_codes:, single spaces.
 */
export function cleanChangelogText(value: string): string {
  return toUkSpelling(value)
    .replace(/\s+[—–]\s+/g, ", ")
    .replace(/[—–]/g, "-")
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍⃣]/gu, "")
    .replace(/<a?:\w+:\d+>/g, "")
    .replace(/(^|\s):[a-z_][a-z0-9_]{1,40}:(?=\s|$)/gi, "$1")
    .replace(/\*\*|__|`+|^#+\s*|^>\s*|^-#\s*/gm, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

const cleanText = (max: number) =>
  z
    .string()
    .transform(cleanChangelogText)
    .pipe(z.string().max(max, `Keep it under ${max} characters.`));

const requiredText = (max: number) => cleanText(max).pipe(z.string().min(1, "This can't be empty."));

const sectionSchema = z
  .object({
    icon: z.enum(CHANGELOG_ICONS, { errorMap: () => ({ message: "Pick one of the listed icons." }) }),
    name: requiredText(60),
    tagline: cleanText(100)
      .nullish()
      .transform((v) => (v ? v : null)),
    paragraphs: z
      .array(cleanText(700))
      .transform((list) => list.filter(Boolean).slice(0, 3)),
    bullets: z
      .array(cleanText(180))
      .transform((list) => list.filter(Boolean).slice(0, 10)),
  })
  .refine((s) => s.paragraphs.length > 0 || s.bullets.length > 0, "A section needs a paragraph or a bullet.");

/** Lists longer than the limits are cut to size rather than rejected (the AI sometimes overshoots);
 *  over-long text and invalid icons are rejected. */
export const changelogContentSchema = z.object({
  title: cleanText(160),
  headline: z
    .array(cleanText(48))
    .transform((list) => list.filter(Boolean).slice(0, 4)),
  summary: cleanText(400),
  sections: z.array(sectionSchema).transform((list) => list.slice(0, 8)),
  smallerImprovements: z
    .array(cleanText(180))
    .transform((list) => list.filter(Boolean).slice(0, 14)),
});

export type ChangelogContent = z.infer<typeof changelogContentSchema>;
export type ChangelogSection = ChangelogContent["sections"][number];

export class ChangelogError extends Error {}

/** Validates and cleans content (from Autopilot or an operator's edit). Throws ChangelogError. */
export function parseChangelogContent(raw: unknown): ChangelogContent {
  const result = changelogContentSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new ChangelogError(`${where}${issue?.message ?? "Invalid changelog content."}`);
  }
  return result.data;
}

export function isEmptyContent(content: ChangelogContent): boolean {
  return content.sections.length === 0 && content.smallerImprovements.length === 0;
}

/** JSON schema for OpenAI strict structured output (mirrors changelogContentSchema). */
export const CHANGELOG_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["title", "headline", "summary", "sections", "smallerImprovements"],
  properties: {
    title: { type: "string", description: "Short headline phrase naming the top features." },
    headline: {
      type: "array",
      description: "2 to 4 short names of the biggest features, in order of importance.",
      items: { type: "string" },
    },
    summary: { type: "string", description: "One sentence summing up the update." },
    sections: {
      type: "array",
      description: "2 to 6 feature sections, most important first.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["icon", "name", "tagline", "paragraphs", "bullets"],
        properties: {
          icon: { type: "string", enum: [...CHANGELOG_ICONS] },
          name: { type: "string" },
          tagline: { type: ["string", "null"], description: "Optional short bold line, e.g. 'Everything in one place.'" },
          paragraphs: { type: "array", description: "1 or 2 short paragraphs (3 at most), each under 500 characters.", items: { type: "string" } },
          bullets: { type: "array", description: "Up to 6 short fragments, each under 120 characters.", items: { type: "string" } },
        },
      },
    },
    smallerImprovements: { type: "array", description: "Up to 8 short fragments, each under 120 characters.", items: { type: "string" } },
  },
};

// --- Leak checks: nothing internal may reach the public page -------------------------------

const LEAK_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "file path", re: /\b[\w.-]+\/[\w./-]+\.(?:tsx?|jsx?|mjs|json|sql|ya?ml|md|css)\b/i },
  { label: "file name", re: /\b[\w-]+\.(?:tsx?|jsx?|mjs|sql|ya?ml)\b/i },
  { label: "environment variable", re: /\b[A-Z][A-Z0-9]{2,}_[A-Z0-9_]{2,}\b/ },
  { label: "commit hash", re: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/ },
  { label: "migration", re: /\bmigrations?\s*#?\d{2,}\b/i },
  { label: "email address", re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/ },
  { label: "code identifier", re: /\b[a-z]+[A-Z][a-zA-Z]*\(\)|\b(?:src|dist|drizzle|node_modules)\/|\b[a-z]{2,}[A-Z][a-z]+[A-Za-z]*\b/ },
  { label: "internal jargon", re: /\b(?:bridge|endpoints?|schemas?|refactor(?:ed|ing)?|database|component ids?|cache keys?)\b/i },
];

/** US to UK spellings for the words that come up in release notes. */
const UK_STEMS =
  "organ|custom|optim|local|normal|synchron|priorit|categor|recogn|real|author|final|initial|personal|visual|summar|standard|minim|maxim|util|emphas|special|modern|central|stabil|sanit|serial|memor|apolog|character|monet|global|revital|famil";
const UK_IZE = new RegExp(`\\b(${UK_STEMS})iz(e|ed|es|ing|ation|ations|er|ers)\\b`, "gi");
const UK_WORDS: [RegExp, string][] = [
  [/\bcolor(s|ed|ful)?\b/gi, "colour$1"],
  [/\bbehavior(s)?\b/gi, "behaviour$1"],
  [/\bfavorite(s)?\b/gi, "favourite$1"],
  [/\bcenter(s|ed)?\b/gi, "centre$1"],
  [/\bcanceled\b/gi, "cancelled"],
  [/\bcatalog(s)?\b/gi, "catalogue$1"],
  [/\banalyz(e|ed|es|ing)\b/gi, "analys$1"],
];

function keepCase(source: string, replacement: string): string {
  return source[0] === source[0]!.toUpperCase() ? replacement[0]!.toUpperCase() + replacement.slice(1) : replacement;
}

export function toUkSpelling(text: string): string {
  let out = text.replace(UK_IZE, (m, stem: string, end: string) => keepCase(m, `${stem.toLowerCase()}is${end.toLowerCase()}`));
  for (const [re, to] of UK_WORDS) out = out.replace(re, (m, ...groups) => keepCase(m, to.replace("$1", typeof groups[0] === "string" ? groups[0].toLowerCase() : "")));
  return out;
}

export function findLeaks(text: string): string[] {
  return LEAK_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.label);
}

function contentStrings(content: ChangelogContent): string[] {
  return [
    content.title,
    content.summary,
    ...content.headline,
    ...content.smallerImprovements,
    ...content.sections.flatMap((s) => [s.name, s.tagline ?? "", ...s.paragraphs, ...s.bullets]),
  ];
}

export function contentLeaks(content: ChangelogContent): string[] {
  return [...new Set(contentStrings(content).flatMap(findLeaks))];
}

/** Last line of defence: drops any bullet or paragraph that still leaks, and sections left empty. */
export function dropLeakyLines(content: ChangelogContent): ChangelogContent {
  const ok = (line: string) => findLeaks(line).length === 0;
  return {
    ...content,
    summary: ok(content.summary) ? content.summary : "",
    headline: content.headline.filter(ok),
    smallerImprovements: content.smallerImprovements.filter(ok),
    sections: content.sections
      .filter((s) => ok(s.name))
      .map((s) => ({
        ...s,
        tagline: s.tagline && ok(s.tagline) ? s.tagline : null,
        paragraphs: s.paragraphs.filter(ok),
        bullets: s.bullets.filter(ok),
      }))
      .filter((s) => s.paragraphs.length > 0 || s.bullets.length > 0),
  };
}

// --- Commit preparation --------------------------------------------------------------------

const AREA_ALIASES: Record<string, string> = {
  hangar: "The Hangar",
  plane_cards: "The Hangar",
  ghost_mode: "Ghost Mode",
  leaderboards: "Leaderboards",
  leaderboard_cache: "Leaderboards",
  dreamliner_one: "Dreamliner One",
  one_entitlements: "Dreamliner One",
  ai: "Autopilot",
  avia: "Avia",
  server_autopilot: "Server Autopilot",
  server_files: "Server Files",
  files: "Server Files",
  store: "Store",
  cosmetics: "Store",
  progression_badges: "Progression badges",
  badges: "Progression badges",
  user_badges: "Progression badges",
  feeds: "Notifications",
  social: "Notifications",
  bluesky: "Bluesky",
  infraction: "Infractions",
  moderation: "Moderation",
  incidents: "Incident Response",
  member_hub: "Members",
  user_profiles: "Profiles",
  user_public_profile: "Profiles",
  user_stats: "Stats",
  stats_insights: "Stats",
  radio: "Radio",
  radios: "Radio",
  playlists: "Music",
  lastfm: "Last.fm",
  status_monitor: "Status page",
  dream_commands: "Custom Commands",
  team_kiosk: "Team Control",
  passport_alts: "Passport",
  ticket_ai: "Tickets",
  tickets_logic: "Tickets",
  switch: "Switch",
  clips: "Clips",
  logs: "Logs",
  language: "Languages",
  onboarding: "Server onboarding",
};

function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function areaName(key: string): string | null {
  return AREA_ALIASES[key] ?? PLUGIN_DISPLAY[key]?.name ?? null;
}

/** The product area a changed file belongs to, if any. File paths themselves are never kept. */
export function areaFromPath(path: string): string | null {
  const p = path.replace(/\\/g, "/");
  if (/\.test\.ts$/.test(p) || p.startsWith("docs/") || p.startsWith("drizzle/") || p.startsWith("scripts/")) return null;
  let m = /^src\/plugins\/([a-z_]+)\//.exec(p);
  if (m) return areaName(m[1]!);
  m = /^src\/bridge\/(?:web)?([A-Za-z]+)\.ts$/.exec(p);
  if (m) return areaName(snake(m[1]!));
  m = /^src\/core\/([A-Za-z]+)(?:\/|\.ts$)/.exec(p);
  if (m) return areaName(snake(m[1]!));
  return null;
}

export function areasFromPaths(paths: string[]): string[] {
  return [...new Set(paths.map(areaFromPath).filter((a): a is string => Boolean(a)))].sort();
}

/** Commit message as Autopilot sees it: no trailers, emails or long bodies. */
export function promptCommitMessage(message: string): string {
  const lines = message
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => !/^(?:co-authored-by|signed-off-by|reviewed-by):/i.test(line.trim()))
    .map((line) => line.replace(/<[^>\s]+@[^>\s]+>/g, "").replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ""));
  const subject = (lines.shift() ?? "").trim();
  const body = lines.join("\n").trim().replace(/\n{3,}/g, "\n\n");
  return body ? `${subject}\n${body.slice(0, 600)}` : subject;
}
