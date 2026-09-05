import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { scamImageHashes } from "../../../db/schema.js";
import { computeDHash, hammingDistance, isValidPhash } from "./imageHash.js";

export type ScamImageHashEntry = {
  id: string;
  phash: string;
  label: string;
  addedBy: string;
  createdAt: number;
};

function toEntry(row: typeof scamImageHashes.$inferSelect): ScamImageHashEntry {
  return {
    id: row.id,
    phash: row.phash,
    label: row.label,
    addedBy: row.addedBy,
    createdAt: row.createdAt.getTime(),
  };
}

// Small, rarely-written global list. An in-memory cache with a short TTL keeps every
// guild's image_scan rule from hitting the DB on every image, while still picking up a
// superuser's add/remove within a few minutes without needing an explicit invalidation
// bus between the dashboard bridge and every automod message handler.
let cache: { entries: ScamImageHashEntry[]; expiresAt: number } | null = null;
const CACHE_TTL_MS = 2 * 60_000;

function invalidateCache(): void {
  cache = null;
}

export async function listScamImageHashes(): Promise<ScamImageHashEntry[]> {
  const rows = await getDb().select().from(scamImageHashes).orderBy(desc(scamImageHashes.createdAt)).all();
  return rows.map(toEntry);
}

async function getCachedEntries(): Promise<ScamImageHashEntry[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.entries;
  const entries = await listScamImageHashes();
  cache = { entries, expiresAt: Date.now() + CACHE_TTL_MS };
  return entries;
}

export type ScamImageHashMatch = { entry: ScamImageHashEntry; distance: number };

/** Closest entry regardless of threshold, for logging/diagnostics. Lets a near-miss show
 * up in logs as "closest was distance 14" instead of nothing at all. */
export async function closestScamImageHash(phash: string): Promise<ScamImageHashMatch | null> {
  const entries = await getCachedEntries();
  let best: ScamImageHashMatch | null = null;
  for (const entry of entries) {
    const distance = hammingDistance(phash, entry.phash);
    if (!best || distance < best.distance) best = { entry, distance };
  }
  return best;
}

/** Closest blocklist entry within `maxDistance` Hamming bits, if any (0 = exact match). */
export async function findScamImageHashMatch(
  phash: string,
  maxDistance: number,
): Promise<ScamImageHashMatch | null> {
  const best = await closestScamImageHash(phash);
  return best && best.distance <= maxDistance ? best : null;
}

/** Every blocklist entry's distance from `phash`, closest first. Used by the dashboard's
 * "test an image" tool so someone can see exactly how close a match is instead of a
 * yes/no answer, without needing to reproduce the check live in a Discord channel. */
export async function rankScamImageHashDistances(phash: string, limit = 5): Promise<ScamImageHashMatch[]> {
  const entries = await getCachedEntries();
  return entries
    .map((entry) => ({ entry, distance: hammingDistance(phash, entry.phash) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

export class ScamImageHashError extends Error {}

/** Adds a hash computed from an already-fetched image buffer (superuser dashboard upload). */
export async function addScamImageHashFromBuffer(
  buffer: Buffer,
  label: string,
  addedBy: string,
): Promise<ScamImageHashEntry> {
  let phash: string;
  try {
    phash = await computeDHash(buffer);
  } catch {
    throw new ScamImageHashError("Could not read that as an image.");
  }
  return addScamImageHash(phash, label, addedBy);
}

export async function addScamImageHash(
  phash: string,
  label: string,
  addedBy: string,
): Promise<ScamImageHashEntry> {
  if (!isValidPhash(phash)) {
    throw new ScamImageHashError("phash must be 16 hex characters (a 64-bit dHash).");
  }
  const row = {
    id: randomUUID(),
    phash: phash.toLowerCase(),
    label: label.trim().slice(0, 200),
    addedBy,
    createdAt: new Date(),
  };
  await getDb().insert(scamImageHashes).values(row);
  invalidateCache();
  return toEntry(row);
}

export async function removeScamImageHash(id: string): Promise<boolean> {
  const result = await getDb().delete(scamImageHashes).where(eq(scamImageHashes.id, id)).run();
  invalidateCache();
  return (result.changes ?? 0) > 0;
}
