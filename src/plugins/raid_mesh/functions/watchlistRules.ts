/** Pure Raid Defense Mesh watchlist rules, kept free of DB/Discord imports so they can be unit tested. */

export const MIN_WATCHLIST_HOURS = 1;
export const MAX_WATCHLIST_HOURS = 168;

export function clampWatchlistHours(hours: number): number {
  if (!Number.isFinite(hours)) return 24;
  return Math.min(MAX_WATCHLIST_HOURS, Math.max(MIN_WATCHLIST_HOURS, Math.round(hours)));
}

/** When a watchlist entry created at `now` stops counting. */
export function watchlistExpiry(now: number, hours: number): Date {
  return new Date(now + clampWatchlistHours(hours) * 3_600_000);
}

/** A watchlist entry only counts while it hasn't expired (the expiry instant itself is expired). */
export function isWatchlistEntryLive(entry: { expiresAt: Date }, now: number): boolean {
  return entry.expiresAt.getTime() > now;
}

/** Unique, snowflake-shaped ids from an alert's joiners, never the alerting guild itself. */
export function watchlistUserIds(joiners: { id: string }[], limit = 15): string[] {
  const ids: string[] = [];
  for (const joiner of joiners) {
    if (!/^\d{15,22}$/.test(joiner.id) || ids.includes(joiner.id)) continue;
    ids.push(joiner.id);
    if (ids.length >= limit) break;
  }
  return ids;
}
