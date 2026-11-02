import type { TeamControlConfig } from "../../../config/schemas/teamControl.js";

const DAY_MS = 86_400_000;

export type LeaveRequestInput = {
  days: number;
  startsInDays: number;
  reason: string;
};

export type LeaveHistory = {
  /** The member already has a pending, approved or active request. */
  hasOpen: boolean;
  /** When their latest request was decided (approved, denied or ended), for the cooldown. */
  lastDecidedAt: Date | null;
};

export type LeaveValidation = { ok: true; startsAt: Date; endsAt: Date } | { ok: false; error: string };

/** Checks a leave request against the server's rules and works out its dates. */
export function validateLeaveRequest(
  input: LeaveRequestInput,
  rules: TeamControlConfig["leave"],
  history: LeaveHistory,
  now = Date.now(),
): LeaveValidation {
  if (!Number.isInteger(input.days) || input.days < rules.min_days || input.days > rules.max_days) {
    return { ok: false, error: `Leave must be between ${rules.min_days} and ${rules.max_days} days.` };
  }
  if (!Number.isInteger(input.startsInDays) || input.startsInDays < 0 || input.startsInDays > 60) {
    return { ok: false, error: "Leave has to start within the next 60 days." };
  }
  if (rules.require_reason && !input.reason.trim()) {
    return { ok: false, error: "Please give a reason for your leave." };
  }
  if (history.hasOpen) {
    return { ok: false, error: "You already have a leave request that's pending or running. End or cancel it first." };
  }
  if (rules.cooldown_days > 0 && history.lastDecidedAt) {
    const until = history.lastDecidedAt.getTime() + rules.cooldown_days * DAY_MS;
    if (until > now) {
      return { ok: false, error: `You can request leave again <t:${Math.floor(until / 1000)}:R>.` };
    }
  }
  const startsAt = new Date(now + input.startsInDays * DAY_MS);
  return { ok: true, startsAt, endsAt: new Date(startsAt.getTime() + input.days * DAY_MS) };
}

/** Extending leave: the new end, capped so the whole leave stays within `max_days`. */
export function extendLeave(
  leave: { startsAt: Date; endsAt: Date },
  days: number,
  maxDays: number,
): { ok: true; endsAt: Date } | { ok: false; error: string } {
  if (!Number.isInteger(days) || days < 1 || days > 365) return { ok: false, error: "Extend by 1 to 365 days." };
  const endsAt = new Date(leave.endsAt.getTime() + days * DAY_MS);
  if (endsAt.getTime() - leave.startsAt.getTime() > maxDays * DAY_MS) {
    return { ok: false, error: `That would make the leave longer than the ${maxDays}-day maximum.` };
  }
  return { ok: true, endsAt };
}

/** When a leave actually stops (ended early, or its planned end). */
export function leaveEffectiveEnd(leave: { endsAt: Date; endedAt: Date | null }): number {
  return Math.min(leave.endsAt.getTime(), leave.endedAt?.getTime() ?? Number.POSITIVE_INFINITY);
}

/** Statuses that mean the leave did (or will) happen. */
export const TAKEN_LEAVE = new Set(["approved", "active", "ended"]);

/**
 * Whether taken leave covers at least half of [from, to): the member is excused from that
 * period's quota. Several short leaves add up; overlapping ones aren't double counted.
 */
export function isExcusedFromPeriod(
  leaves: Array<{ status: string; startsAt: Date; endsAt: Date; endedAt: Date | null }>,
  from: number,
  to: number,
): boolean {
  if (to <= from) return false;
  const spans = leaves
    .filter((leave) => TAKEN_LEAVE.has(leave.status))
    .map((leave) => [Math.max(from, leave.startsAt.getTime()), Math.min(to, leaveEffectiveEnd(leave))] as const)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let cursor = from;
  for (const [start, end] of spans) {
    const s = Math.max(start, cursor);
    if (end > s) {
      covered += end - s;
      cursor = end;
    }
  }
  return covered >= (to - from) / 2;
}
