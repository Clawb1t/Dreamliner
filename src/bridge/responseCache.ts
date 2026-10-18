/**
 * Lightweight in-memory cache for expensive bridge responses (leaderboards, public profiles,
 * guild/global stats, the config schema). These all do multiple Discord REST calls (some forced, to
 * get banner/accent data gateway caching doesn't carry) plus several DB queries. Single-process, no
 * external dependency; fine for a single bot instance.
 *
 * Stale-while-revalidate: within the TTL a value is returned as is. Past it (up to a longer "stale"
 * window) the old value is STILL returned immediately while a fresh one is computed in the
 * background, so only the very first request, or one after a long quiet spell, ever waits on the
 * slow work. A failed background refresh keeps serving the old value.
 */

import { getLogger } from "../core/logger.js";
import { capMap, createPruner } from "../core/mapPrune.js";

const log = getLogger("cache");

type Entry<T> = { value: T; freshUntil: number; staleUntil: number };

const store = new Map<string, Entry<unknown>>();
/** Keys include user ids, guild ids and query variants, so entries past their stale window must be
 *  dropped (they used to stay until the same key was requested again, which was often never). */
const pruneStore = createPruner(store, (entry, now) => entry.staleUntil <= now);
const MAX_ENTRIES = 2000;
/** In-flight computations, so concurrent requests for the same key share one call instead of stampeding. */
const inFlight = new Map<string, Promise<unknown>>();

const MAX_STALE_MS = 10 * 60_000;

function refresh<T>(key: string, freshMs: number, staleMs: number, compute: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const startedAt = process.hrtime.bigint();
  const promise = (async () => {
    try {
      const value = await compute();
      const now = Date.now();
      pruneStore();
      store.delete(key); // re-insert at the end, so capMap drops the oldest first
      store.set(key, { value, freshUntil: now + freshMs, staleUntil: now + staleMs });
      capMap(store, MAX_ENTRIES);
      log.debug(`miss ${key} (computed in ${(Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(1)}ms)`);
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

/** Stale-while-revalidate with an explicit stale window. */
export async function cachedSwr<T>(key: string, freshMs: number, staleMs: number, compute: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const entry = store.get(key) as Entry<T> | undefined;
  if (entry && entry.freshUntil > now) return entry.value;
  if (entry && entry.staleUntil > now) {
    void refresh(key, freshMs, staleMs, compute).catch((error) =>
      log.warn(`background refresh of ${key} failed: ${error instanceof Error ? error.message : error}`),
    );
    return entry.value;
  }
  return refresh(key, freshMs, staleMs, compute);
}

/** Cached for `ttlMs`, then served stale (up to 10x longer, at most 10 minutes) while it refreshes. */
export function cached<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  return cachedSwr(key, ttlMs, Math.min(ttlMs * 10, MAX_STALE_MS), compute);
}

/** Clears cached entries whose key starts with `prefix` (or every entry if omitted). */
export function invalidateCached(prefix?: string): void {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
