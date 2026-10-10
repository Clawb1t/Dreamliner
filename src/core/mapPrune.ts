/**
 * Helpers for long-lived in-memory maps (cooldowns, rate buckets, small caches). A map that only
 * ever has entries added grows for as long as the bot runs, one key per user, message or query it
 * has seen. These keep such maps bounded without timers of their own.
 */

/**
 * Returns a function to call on each write: at most once per `everyMs` it deletes every entry
 * `isStale` says is finished (an expired cooldown, a window with no recent hits).
 */
export function createPruner<K, V>(
  map: Map<K, V>,
  isStale: (value: V, now: number) => boolean,
  everyMs = 60_000,
): (now?: number) => void {
  let lastRun = Number.NEGATIVE_INFINITY;
  return (now = Date.now()) => {
    if (now - lastRun < everyMs) return;
    lastRun = now;
    for (const [key, value] of map) {
      if (isStale(value, now)) map.delete(key);
    }
  };
}

/** Hard ceiling: drops the oldest entries (insertion order) once the map is over `max`. */
export function capMap<K, V>(map: Map<K, V>, max: number): void {
  if (map.size <= max) return;
  let excess = map.size - Math.floor(max * 0.9);
  for (const key of map.keys()) {
    if (excess-- <= 0) break;
    map.delete(key);
  }
}
