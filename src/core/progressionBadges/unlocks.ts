import { inArray } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { userProgressionBadgeUnlocks } from "../../db/schema.js";
import { getLogger } from "../logger.js";

const log = getLogger("progression-badges");

/**
 * When each user first reached each tier, for the badge window's "Unlocked" date. Recorded as
 * badges are resolved: the first time a user is seen holding a badge, the tiers they already hold
 * are stored without a date (nobody knows when they were really reached); every tier after that
 * gets the moment it was first seen.
 */

type UserUnlocks = Map<string, Map<number, number | null>>;

const TTL_MS = 5 * 60_000;
const MAX_USERS = 5_000;
const cache = new Map<string, { at: number; byBadge: UserUnlocks }>();

function load(userIds: string[]): Map<string, UserUnlocks> {
  const now = Date.now();
  const result = new Map<string, UserUnlocks>();
  const missing: string[] = [];
  for (const userId of userIds) {
    const hit = cache.get(userId);
    if (hit && now - hit.at < TTL_MS) result.set(userId, hit.byBadge);
    else missing.push(userId);
  }
  if (missing.length > 0) {
    for (const userId of missing) result.set(userId, new Map());
    const rows = getDb()
      .select()
      .from(userProgressionBadgeUnlocks)
      .where(inArray(userProgressionBadgeUnlocks.userId, missing))
      .all();
    for (const row of rows) {
      const byBadge = result.get(row.userId)!;
      const tiers = byBadge.get(row.badgeKey) ?? new Map<number, number | null>();
      tiers.set(row.tier, row.unlockedAt ? row.unlockedAt.getTime() : null);
      byBadge.set(row.badgeKey, tiers);
    }
    for (const userId of missing) cache.set(userId, { at: now, byBadge: result.get(userId)! });
    while (cache.size > MAX_USERS) cache.delete(cache.keys().next().value!);
  }
  return result;
}

export type HeldTier = { userId: string; badgeKey: string; tier: number };

/** Records newly reached tiers and returns when each held tier was unlocked (ISO, or null when
 *  unknown), keyed `${userId}:${badgeKey}`. Never throws: a missing table just means no dates. */
export function resolveUnlocks(held: HeldTier[], now = Date.now()): Map<string, string | null> {
  const result = new Map<string, string | null>();
  if (held.length === 0) return result;
  try {
    const byUser = load([...new Set(held.map((entry) => entry.userId))]);
    const inserts: Array<typeof userProgressionBadgeUnlocks.$inferInsert> = [];
    for (const { userId, badgeKey, tier } of held) {
      const byBadge = byUser.get(userId)!;
      let tiers = byBadge.get(badgeKey);
      const firstSight = !tiers || tiers.size === 0;
      if (!tiers) {
        tiers = new Map();
        byBadge.set(badgeKey, tiers);
      }
      const highest = tiers.size ? Math.max(...tiers.keys()) : 0;
      for (let position = highest + 1; position <= tier; position++) {
        const at = firstSight ? null : now;
        tiers.set(position, at);
        inserts.push({ userId, badgeKey, tier: position, unlockedAt: at == null ? null : new Date(at) });
      }
      const at = tiers.get(tier);
      result.set(`${userId}:${badgeKey}`, at == null ? null : new Date(at).toISOString());
    }
    if (inserts.length > 0) {
      const db = getDb();
      db.transaction(() => {
        for (const row of inserts) db.insert(userProgressionBadgeUnlocks).values(row).onConflictDoNothing().run();
      });
    }
  } catch (error) {
    log.debug("Couldn't record badge unlocks:", error);
  }
  return result;
}

/** Test hook. */
export function clearUnlockCache(): void {
  cache.clear();
}
