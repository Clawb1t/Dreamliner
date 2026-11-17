/** Random source in [0, 1). Injected everywhere a roll happens so tests can seed it. */
export type Rng = () => number;

export const defaultRng: Rng = Math.random;

/** Small deterministic PRNG for tests and simulations. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks a key by weight. Non-positive and non-finite weights are skipped; null when nothing has weight. */
export function weightedPick<K extends string>(weights: Partial<Record<K, number>>, rng: Rng, allowed?: (key: K) => boolean): K | null {
  const entries = (Object.entries(weights) as [K, number][]).filter(
    ([key, weight]) => Number.isFinite(weight) && weight > 0 && (!allowed || allowed(key)),
  );
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) return null;
  let roll = rng() * total;
  for (const [key, weight] of entries) {
    roll -= weight;
    if (roll < 0) return key;
  }
  return entries[entries.length - 1]![0];
}

export function pickOne<T>(items: readonly T[], rng: Rng): T | null {
  if (items.length === 0) return null;
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))]!;
}
