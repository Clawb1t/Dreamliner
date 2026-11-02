import type { TeamStrikeAction, TeamStrikeThreshold } from "../../../config/schemas/teamControl.js";

const SEVERITY: Record<TeamStrikeAction, number> = { notify: 0, demote: 1, suspend: 2, terminate: 3 };

/** When a new strike stops counting, or null when strikes never expire. */
export function strikeExpiry(expiryDays: number, now = Date.now()): Date | null {
  return expiryDays > 0 ? new Date(now + expiryDays * 86_400_000) : null;
}

/** Strikes that still count: not voided and not expired. */
export function countActiveStrikes(
  rows: Array<{ type: string; voidedAt: Date | null; expiresAt: Date | null }>,
  now = Date.now(),
): number {
  return rows.filter((row) => row.type === "strike" && !row.voidedAt && (!row.expiresAt || row.expiresAt.getTime() > now)).length;
}

/**
 * The threshold a new strike crosses, going from `before` to `after` active strikes: the highest
 * strike count crossed, the most severe action on a tie. Null when none is crossed, so a
 * threshold fires once per crossing rather than on every later strike.
 */
export function crossedThreshold(thresholds: TeamStrikeThreshold[], before: number, after: number): TeamStrikeThreshold | null {
  let best: TeamStrikeThreshold | null = null;
  for (const threshold of thresholds) {
    if (threshold.strikes <= before || threshold.strikes > after) continue;
    if (
      !best ||
      threshold.strikes > best.strikes ||
      (threshold.strikes === best.strikes && SEVERITY[threshold.action] > SEVERITY[best.action])
    ) {
      best = threshold;
    }
  }
  return best;
}
