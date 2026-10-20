import { invalidateCached } from "../../bridge/responseCache.js";
import type { CosmeticStyle } from "./types.js";

/**
 * Resolved equipped styles per user, cached for about a minute (leaderboards ask for 25 users at a
 * time). Kept in its own module so the store's purchase path can drop an entry without importing
 * the equip module.
 */

export const COSMETICS_CACHE_MS = 60_000;
const MAX_ENTRIES = 5000;

const styles = new Map<string, { at: number; style: CosmeticStyle }>();

export function getCachedStyle(userId: string, now = Date.now()): CosmeticStyle | undefined {
  const entry = styles.get(userId);
  if (!entry) return undefined;
  if (now - entry.at >= COSMETICS_CACHE_MS) {
    styles.delete(userId);
    return undefined;
  }
  return entry.style;
}

export function setCachedStyle(userId: string, style: CosmeticStyle, now = Date.now()): void {
  styles.delete(userId);
  styles.set(userId, { at: now, style });
  while (styles.size > MAX_ENTRIES) {
    const oldest = styles.keys().next().value;
    if (oldest === undefined) break;
    styles.delete(oldest);
  }
}

/** Forgets a user's resolved styles here and in the bridge's cached public profile payloads. */
export function invalidateUserCosmetics(userId: string): void {
  styles.delete(userId);
  invalidateCached(`pp-id:${userId}`);
  invalidateCached(`pp:${userId}`);
}

/** Every user (after a catalog change, since a product's style may have changed). */
export function invalidateAllCosmetics(): void {
  styles.clear();
}
