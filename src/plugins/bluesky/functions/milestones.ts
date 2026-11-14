/**
 * Follower milestones: pure maths, shared by the poller (milestonePoller.ts), the bridge (seeding
 * when the option is turned on) and the dashboard stats. Tested in milestones.test.ts.
 *
 * The ladder is 100, 250, 500, 1K, 2.5K, 5K, 10K, 25K, 50K, 100K, 250K, 500K, 1M, then every 1M.
 */

const FIXED_MILESTONES = [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];
const MILLION = 1_000_000;

/** Stored in `options.milestone_last` while the starting point hasn't been recorded yet. */
export const MILESTONE_UNSEEDED = -1;

/** The highest milestone at or below `followers` (0 when under the first one). */
export function milestoneAtOrBelow(followers: number): number {
  const count = Math.max(0, Math.floor(followers));
  if (count >= MILLION) return Math.floor(count / MILLION) * MILLION;
  let reached = 0;
  for (const milestone of FIXED_MILESTONES) {
    if (count >= milestone) reached = milestone;
    else break;
  }
  return reached;
}

/** The next milestone strictly above `followers`. */
export function nextMilestone(followers: number): number {
  const count = Math.max(0, Math.floor(followers));
  if (count >= MILLION) return (Math.floor(count / MILLION) + 1) * MILLION;
  return FIXED_MILESTONES.find((milestone) => milestone > count) ?? MILLION;
}

/**
 * The milestone to announce, or null. Only the highest crossed milestone is announced (a jump
 * from 90 to 600 announces 500 once), and a milestone is never announced twice: `lastAnnounced`
 * only moves up, so dipping under a milestone and climbing back over it stays quiet.
 * An unseeded feed never announces; the caller seeds it with `milestoneAtOrBelow` instead.
 */
export function milestoneToAnnounce(lastAnnounced: number, followers: number): number | null {
  if (lastAnnounced < 0) return null;
  const reached = milestoneAtOrBelow(followers);
  return reached > lastAnnounced ? reached : null;
}

/** 100, 250, 1K, 2.5K, 10K, 1M, 2M... for card titles. */
export function formatMilestone(value: number): string {
  if (value >= MILLION) {
    const millions = value / MILLION;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
  }
  return String(value);
}
