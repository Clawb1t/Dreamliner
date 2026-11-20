/**
 * Cross-server privacy rules: pure functions, no database. `ghostMode.ts` loads the state and calls
 * these; every surface that shows one user's activity from outside the current server to someone
 * else goes through `resolveCrossServerAccess` (via `canViewCrossServerData`).
 *
 * Two layers:
 * - For everyone, always: another person's global numbers are a snapshot taken at 00:00 UTC
 *   ("snapshot"), never live, so polling a profile, /rank or a global board can't tell whether
 *   someone is posting in some other server right now. "Active now" / "Last seen 5m ago" stays
 *   visible to everyone by design.
 * - Ghost Mode (opt-in, optionally timed): other people see nothing cross-server at all
 *   ("hidden"), including Active now / Last seen, and the user is left off the global leaderboards.
 *
 * The user themselves and the people on their allow list always get "live".
 *
 * None of this changes what is tracked. Messages, voice time, streaks, XP and coins keep counting
 * exactly as before; these rules only decide what OTHER people are shown.
 */

export type CrossServerAccess = "live" | "snapshot" | "hidden";

export type GhostState = {
  /** The switch as stored. Use `isGhostActive` to account for expiry. */
  enabled: boolean;
  /** When it turns itself off, null = until the user turns it off. */
  until: Date | null;
  /** Leave the user off the global leaderboards (implied while Ghost Mode is active). */
  hideLeaderboards: boolean;
};

export const GHOST_OFF: GhostState = { enabled: false, until: null, hideLeaderboards: false };

/** Most people one user can let see through their Ghost Mode. */
export const GHOST_ALLOWLIST_MAX = 50;

export const GHOST_DURATIONS = {
  "1h": 60 * 60_000,
  "8h": 8 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "3d": 3 * 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
  forever: null,
} as const satisfies Record<string, number | null>;

export type GhostDuration = keyof typeof GHOST_DURATIONS;

export const GHOST_DURATION_LABELS: Record<GhostDuration, string> = {
  "1h": "1 hour",
  "8h": "8 hours",
  "24h": "24 hours",
  "3d": "3 days",
  "1w": "1 week",
  forever: "Until I turn it off",
};

export function isGhostDuration(value: unknown): value is GhostDuration {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(GHOST_DURATIONS, value);
}

/** When Ghost Mode set for `duration` from `now` ends (null = never). */
export function ghostUntilFromDuration(duration: GhostDuration, now = new Date()): Date | null {
  const ms = GHOST_DURATIONS[duration];
  return ms === null ? null : new Date(now.getTime() + ms);
}

/** On, and not past its end time. Expiry needs no scheduler: every check compares with now. */
export function isGhostActive(state: GhostState | null | undefined, now = new Date()): boolean {
  if (!state?.enabled) return false;
  return state.until === null || state.until.getTime() > now.getTime();
}

/** Left off the global leaderboards: while Ghost Mode is active, or by the separate switch. */
export function isHiddenFromGlobalBoards(state: GhostState | null | undefined, now = new Date()): boolean {
  return Boolean(state?.hideLeaderboards) || isGhostActive(state, now);
}

/**
 * THE rule. What `viewerId` (null = signed out / anyone, e.g. a public page or cached board) may see
 * of `subjectId`'s activity outside the current server.
 */
export function resolveCrossServerAccess(input: {
  viewerId: string | null | undefined;
  subjectId: string;
  ghost: GhostState | null | undefined;
  /** `viewerId` is on the subject's Ghost Mode allow list. */
  allowlisted: boolean;
  now?: Date;
}): CrossServerAccess {
  const { viewerId, subjectId, ghost, allowlisted, now = new Date() } = input;
  if (viewerId && viewerId === subjectId) return "live";
  if (viewerId && allowlisted) return "live";
  if (isGhostActive(ghost, now)) return "hidden";
  return "snapshot";
}

// --- Snapshots ---------------------------------------------------------------------------------

/** UTC calendar date, YYYY-MM-DD (same format as stat_date and SQLite's date('now')). */
export function utcDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** 00:00 UTC today: what every snapshot is "as of". */
export function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * A trigger-maintained counter's value at 00:00 UTC today (see migration 0152). When the row last
 * changed on an earlier day, the live value IS the day-start value. When it changed today, the
 * trigger saved the old value in `dayStart`. Null when it can't be told (a row that last changed
 * today before the triggers existed): callers fall back to another estimate.
 */
export function dayStartValue<T>(row: { live: T; dayStart: T | null; dayStartDate: string | null }, now = new Date()): T | null {
  if (row.dayStartDate === utcDate(now)) return row.dayStart;
  if (row.dayStartDate === null) return null;
  return row.live;
}

// --- Leaderboards ------------------------------------------------------------------------------

/**
 * Drops hidden users from a ranked list and renumbers it, so ranks stay 1..n with no gaps and
 * someone's position never hints that a hidden user sits above them.
 */
export function withoutHidden<T extends { userId: string }>(entries: readonly T[], hidden: ReadonlySet<string>, limit = Infinity): Array<T & { rank: number }> {
  const out: Array<T & { rank: number }> = [];
  for (const entry of entries) {
    if (hidden.has(entry.userId)) continue;
    out.push({ ...entry, rank: out.length + 1 });
    if (out.length >= limit) break;
  }
  return out;
}

/** Rank among visible users: 1 + visible users strictly ahead. */
export function visibleRank(aheadTotal: number, aheadHidden: number): number {
  return Math.max(0, aheadTotal - aheadHidden) + 1;
}

/** Badges earned from a tracked stat carry live progress numbers; a built-in or assigned badge
 *  has `progress: null`. */
export function filterBadgesForAccess<T extends { progress: unknown }>(badges: readonly T[], access: CrossServerAccess): T[] {
  if (access === "live") return [...badges];
  // Ghost Mode: activity badges go (they reveal activity levels across servers); hand-assigned and
  // built-in ones stay. Otherwise the badges stay but without their live progress numbers.
  if (access === "hidden") return badges.filter((badge) => badge.progress === null);
  return badges.map((badge) => ({ ...badge, progress: null }));
}
