/**
 * When Dreamliner Wrapped is open. "Dreamliner Wrapped 2026" covers the 2026 calendar year (UTC).
 * Each edition has three phases (all UTC):
 *  - closed: until 20 November. The site says "Wrapped returns in December".
 *  - countdown: 20 November to 1 December. The page is live with a countdown to opening day.
 *  - open: 1 December until the end of 31 January the following year. The deck itself.
 *
 * Dashboard superusers can open a preview of any edition at any time (an explicit "Preview" from
 * the countdown or closed page). `WRAPPED_FORCE_OPEN=1` opens the current edition for everyone
 * (local development and testing).
 *
 * Mirrored on the website in src/lib/wrapped.ts: keep the two in step.
 */

/** The first year Dreamliner recorded enough activity for a Wrapped. */
export const WRAPPED_FIRST_YEAR = 2025;

export type WrappedPhase = "closed" | "countdown" | "open";

export type WrappedWindow = {
  /** The edition this window belongs to: the one that's open or counting down, or the next one. */
  year: number;
  phase: WrappedPhase;
  /** True while the deck is open to everyone (phase "open", or forced open). */
  open: boolean;
  /** ISO, 20 November of `year`, 00:00 UTC: the countdown starts. */
  countdownAt: string;
  /** ISO, 1 December of `year`, 00:00 UTC. */
  opensAt: string;
  /** ISO, 1 February of `year + 1`, 00:00 UTC (exclusive). */
  closesAt: string;
};

export function isWrappedForcedOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WRAPPED_FORCE_OPEN?.trim() === "1";
}

export function wrappedWindow(now = new Date(), forceOpen = isWrappedForcedOpen()): WrappedWindow {
  const fullYear = now.getUTCFullYear();
  // January is still last year's edition; from February on it's this year's (upcoming) one.
  const year = now.getUTCMonth() === 0 ? fullYear - 1 : fullYear;
  const countdownAt = Date.UTC(year, 10, 20);
  const opensAt = Date.UTC(year, 11, 1);
  const closesAt = Date.UTC(year + 1, 1, 1);
  const t = now.getTime();
  let phase: WrappedPhase = t >= opensAt && t < closesAt ? "open" : t >= countdownAt && t < opensAt ? "countdown" : "closed";
  if (forceOpen) phase = "open";
  return {
    year,
    phase,
    open: phase === "open",
    countdownAt: new Date(countdownAt).toISOString(),
    opensAt: new Date(opensAt).toISOString(),
    closesAt: new Date(closesAt).toISOString(),
  };
}

export type WrappedAccess =
  | { ok: true; year: number; preview: boolean }
  | { ok: false; reason: "closed"; window: WrappedWindow }
  | { ok: false; reason: "invalid_year" };

/**
 * Which edition a viewer may open. Everyone gets the current edition while it's open. A superuser
 * who explicitly asks for a preview can open any edition (2025 onwards) at any time; anyone else
 * asking for a preview is treated like everyone else.
 */
export function resolveWrappedAccess(
  requestedYear: number | null,
  options: { superuser: boolean; preview?: boolean; now?: Date; forceOpen?: boolean },
): WrappedAccess {
  const now = options.now ?? new Date();
  const window = wrappedWindow(now, options.forceOpen ?? isWrappedForcedOpen());
  const year = requestedYear ?? window.year;
  if (!Number.isInteger(year) || year < WRAPPED_FIRST_YEAR || year > now.getUTCFullYear()) {
    return { ok: false, reason: "invalid_year" };
  }
  if (options.superuser && options.preview) return { ok: true, year, preview: !window.open || year !== window.year };
  if (!window.open) return { ok: false, reason: "closed", window };
  if (year !== window.year) return { ok: false, reason: "invalid_year" };
  return { ok: true, year, preview: false };
}

/** UTC bounds of a calendar year in every unit the tables use. */
export function yearBounds(year: number): {
  startDate: string;
  endDate: string;
  startMs: number;
  endMs: number;
  startSec: number;
  endSec: number;
} {
  const startMs = Date.UTC(year, 0, 1);
  const endMs = Date.UTC(year + 1, 0, 1);
  return {
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
    startMs,
    endMs,
    startSec: Math.floor(startMs / 1000),
    endSec: Math.floor(endMs / 1000),
  };
}

/** The UTC calendar year a timestamp falls in (what the per-year counters are keyed by). */
export function wrappedYearOf(at: Date | number = Date.now()): number {
  return new Date(at).getUTCFullYear();
}
