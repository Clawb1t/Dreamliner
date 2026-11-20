/**
 * Ghost Mode state (per user, global) and the single gate every cross-server surface asks:
 * `canViewCrossServerData(viewerId, subjectId)`. Rules live in policy.ts.
 *
 * Ghost Mode never pauses tracking. Stats, XP, streaks, voice time and the economy carry on as
 * normal; this only changes what other people are shown.
 *
 * Bot owner / superuser tooling: the platform-only abuse tools (Global Watchdog, superuser badge
 * admin, data export for the user themselves) read the underlying tables directly and are not
 * gated, so abuse can still be investigated. No public or server-staff surface is exempt.
 */
import { and, desc, eq, gt, isNull, or, inArray, count } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { ghostModeAllowlist, userProfiles } from "../../db/schema.js";
import {
  GHOST_ALLOWLIST_MAX,
  GHOST_OFF,
  ghostUntilFromDuration,
  isGhostActive,
  resolveCrossServerAccess,
  type CrossServerAccess,
  type GhostDuration,
  type GhostState,
} from "./policy.js";

export type { CrossServerAccess, GhostState } from "./policy.js";

type Listener = (userId: string) => void;
const listeners = new Set<Listener>();

/** Called after any Ghost Mode or allow list change, so caches holding that user's public data can
 *  drop it (registered by the bridge, see dashboardBridge.ts). */
export function onGhostModeChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emitChange(userId: string) {
  for (const listener of listeners) {
    try {
      listener(userId);
    } catch {
      /* a cache hook failing must not fail the save */
    }
  }
}

export function getGhostState(userId: string): GhostState {
  const row = getDb()
    .select({ enabled: userProfiles.ghostMode, until: userProfiles.ghostUntil, hideLeaderboards: userProfiles.ghostHideLeaderboards })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .get();
  if (!row) return { ...GHOST_OFF };
  const state: GhostState = { enabled: Boolean(row.enabled), until: row.until ?? null, hideLeaderboards: Boolean(row.hideLeaderboards) };
  // Lazy cleanup: an expired timer reads as off everywhere already; tidy the row too.
  if (state.enabled && !isGhostActive(state)) {
    getDb().update(userProfiles).set({ ghostMode: false, ghostUntil: null }).where(eq(userProfiles.userId, userId)).run();
    return { ...state, enabled: false, until: null };
  }
  return state;
}

function ensureProfileRow(userId: string) {
  getDb().insert(userProfiles).values({ userId, updatedAt: new Date() }).onConflictDoNothing().run();
}

/** Turns Ghost Mode on for `duration` (from now), or off with `null`. */
export function setGhostMode(userId: string, duration: GhostDuration | null, now = new Date()): GhostState {
  ensureProfileRow(userId);
  getDb()
    .update(userProfiles)
    .set(duration === null ? { ghostMode: false, ghostUntil: null, updatedAt: now } : { ghostMode: true, ghostUntil: ghostUntilFromDuration(duration, now), updatedAt: now })
    .where(eq(userProfiles.userId, userId))
    .run();
  emitChange(userId);
  return getGhostState(userId);
}

export function setHideFromGlobalBoards(userId: string, hide: boolean): GhostState {
  ensureProfileRow(userId);
  getDb().update(userProfiles).set({ ghostHideLeaderboards: hide, updatedAt: new Date() }).where(eq(userProfiles.userId, userId)).run();
  emitChange(userId);
  return getGhostState(userId);
}

// --- Allow list --------------------------------------------------------------------------------

export function listGhostAllowlist(userId: string): Array<{ viewerId: string; addedAt: Date }> {
  return getDb()
    .select({ viewerId: ghostModeAllowlist.viewerId, addedAt: ghostModeAllowlist.addedAt })
    .from(ghostModeAllowlist)
    .where(eq(ghostModeAllowlist.userId, userId))
    .orderBy(desc(ghostModeAllowlist.addedAt))
    .all();
}

export function isGhostAllowlisted(userId: string, viewerId: string): boolean {
  return Boolean(
    getDb()
      .select({ viewerId: ghostModeAllowlist.viewerId })
      .from(ghostModeAllowlist)
      .where(and(eq(ghostModeAllowlist.userId, userId), eq(ghostModeAllowlist.viewerId, viewerId)))
      .get(),
  );
}

export class GhostAllowlistError extends Error {}

export function addToGhostAllowlist(userId: string, viewerId: string): void {
  if (!/^\d{15,22}$/.test(viewerId)) throw new GhostAllowlistError("That isn't a valid user.");
  if (viewerId === userId) throw new GhostAllowlistError("You can always see your own data.");
  const db = getDb();
  const existing = db.select({ n: count() }).from(ghostModeAllowlist).where(eq(ghostModeAllowlist.userId, userId)).get();
  if (!isGhostAllowlisted(userId, viewerId) && Number(existing?.n ?? 0) >= GHOST_ALLOWLIST_MAX) {
    throw new GhostAllowlistError(`You can let up to ${GHOST_ALLOWLIST_MAX} people see through Ghost Mode.`);
  }
  db.insert(ghostModeAllowlist).values({ userId, viewerId, addedAt: new Date() }).onConflictDoNothing().run();
  emitChange(userId);
}

export function removeFromGhostAllowlist(userId: string, viewerId: string): void {
  getDb().delete(ghostModeAllowlist).where(and(eq(ghostModeAllowlist.userId, userId), eq(ghostModeAllowlist.viewerId, viewerId))).run();
  emitChange(userId);
}

// --- The gate ----------------------------------------------------------------------------------

/**
 * What `viewerId` may see of `subjectId`'s activity outside the current server: "live" (self or
 * allow-listed), "hidden" (Ghost Mode) or "snapshot" (everyone else: 00:00 UTC values for numbers; last seen stays exact
 * times). `viewerId` null means an anonymous or shared view (public pages, cached boards).
 */
export function canViewCrossServerData(viewerId: string | null | undefined, subjectId: string, now = new Date()): CrossServerAccess {
  if (viewerId && viewerId === subjectId) return "live";
  const ghost = getGhostState(subjectId);
  const allowlisted = Boolean(viewerId) && isGhostAllowlisted(subjectId, viewerId!);
  return resolveCrossServerAccess({ viewerId, subjectId, ghost, allowlisted, now });
}

/** `canViewCrossServerData` for many subjects at once (leaderboard rows), anonymous viewer. */
export function crossServerAccessForMany(subjectIds: readonly string[], now = new Date()): Map<string, CrossServerAccess> {
  const hidden = ghostedAmong(subjectIds, now);
  return new Map(subjectIds.map((id) => [id, hidden.has(id) ? "hidden" : "snapshot"] as const));
}

function ghostedAmong(subjectIds: readonly string[], now: Date): Set<string> {
  const unique = [...new Set(subjectIds)];
  if (!unique.length) return new Set();
  const rows = getDb()
    .select({ userId: userProfiles.userId })
    .from(userProfiles)
    .where(and(inArray(userProfiles.userId, unique), eq(userProfiles.ghostMode, true), or(isNull(userProfiles.ghostUntil), gt(userProfiles.ghostUntil, now))))
    .all();
  return new Set(rows.map((row) => row.userId));
}

/** Everyone currently left off the global leaderboards (Ghost Mode active, or the separate switch). */
export function listHiddenFromGlobalBoards(now = new Date()): Set<string> {
  const rows = getDb()
    .select({ userId: userProfiles.userId })
    .from(userProfiles)
    .where(
      or(
        eq(userProfiles.ghostHideLeaderboards, true),
        and(eq(userProfiles.ghostMode, true), or(isNull(userProfiles.ghostUntil), gt(userProfiles.ghostUntil, now))),
      ),
    )
    .all();
  return new Set(rows.map((row) => row.userId));
}
