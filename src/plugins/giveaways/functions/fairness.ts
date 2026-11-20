import { createHash, randomBytes } from "node:crypto";

/**
 * Verifiable draws. Every draw gets a fresh random seed, and the winners follow from three public
 * things only: the seed, the pool (entrants and their weights) and how many to pick. The seed and a
 * hash of the pool are stored with each draw (giveaway_draws), so anyone can re-run it:
 *
 * 1. Sort the pool by user id (string order) and drop anyone already excluded or with weight <= 0.
 * 2. Random numbers: the n-th number (n = 0, 1, 2...) is the first 6 bytes of
 *    sha256("<seed>:<n>") read as a big-endian integer, divided by 2^48.
 * 3. For each pick: target = number * total weight of who's left; walk the sorted pool adding up
 *    weights and pick the first entrant where the running total passes the target; remove them.
 *
 * The pool hash is sha256 of "<userId>:<weight>" lines (sorted, joined with "\n").
 */

export type WeightedEntrant = { userId: string; weight: number };

export function createSeed(): string {
  return randomBytes(32).toString("hex");
}

export function seededRandom(seed: string): () => number {
  let counter = 0;
  return () => {
    const digest = createHash("sha256").update(`${seed}:${counter++}`).digest();
    return digest.readUIntBE(0, 6) / 2 ** 48;
  };
}

function sortPool(entries: WeightedEntrant[]): WeightedEntrant[] {
  return [...entries].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

function normalWeight(weight: number): number {
  return Number.isFinite(weight) ? Math.round(weight * 1000) / 1000 : 0;
}

export function poolHash(entries: WeightedEntrant[]): string {
  const lines = sortPool(entries).map((e) => `${e.userId}:${normalWeight(e.weight)}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** Weighted sampling without replacement. Zero/negative weights never win. */
export function weightedPick(
  entries: WeightedEntrant[],
  count: number,
  exclude: Set<string> = new Set(),
  random: () => number = Math.random,
): string[] {
  const pool = sortPool(entries).filter((e) => !exclude.has(e.userId) && normalWeight(e.weight) > 0);
  const picks: string[] = [];

  while (picks.length < count && pool.length > 0) {
    const totalWeight = pool.reduce((sum, e) => sum + normalWeight(e.weight), 0);
    if (totalWeight <= 0) break;

    const target = random() * totalWeight;
    let cumulative = 0;
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      cumulative += normalWeight(pool[i]!.weight);
      if (target < cumulative) {
        index = i;
        break;
      }
    }

    picks.push(pool[index]!.userId);
    pool.splice(index, 1);
  }

  return picks;
}

/** Re-runs a stored draw: the same seed and pool always give the same winners. */
export function verifyDraw(seed: string, entries: WeightedEntrant[], count: number, exclude: Set<string> = new Set()): string[] {
  return weightedPick(entries, count, exclude, seededRandom(seed));
}
