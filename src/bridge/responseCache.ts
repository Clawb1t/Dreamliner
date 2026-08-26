/**
 * Lightweight in-memory TTL cache for expensive bridge responses (leaderboards,
 * public profiles, guild/global stats) — these all do multiple Discord REST
 * calls (some forced, to get banner/accent data gateway caching doesn't carry)
 * plus several DB queries, so repeat requests within the TTL window are served
 * straight from memory instead of redoing all of that work. Single-process,
 * no external dependency; fine for a single bot instance.
 */

type CacheEntry<T> = { value: T; expiresAt: number };

const store = new Map<string, CacheEntry<unknown>>();
/** In-flight computations, so concurrent requests for the same key share one call instead of stampeding. */
const inFlight = new Map<string, Promise<unknown>>();

export async function cached<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const entry = store.get(key);
  if (entry && entry.expiresAt > now) {
    return entry.value as T;
  }

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = (async () => {
    try {
      const value = await compute();
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
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
