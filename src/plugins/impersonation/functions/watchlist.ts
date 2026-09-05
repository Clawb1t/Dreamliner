import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { impersonationWatchlist } from "../../../db/schema.js";
import { computeDHash, isValidPhash } from "../../automod/functions/imageHash.js";
import { fetchImageBuffer } from "../../../core/imageFetch.js";

export class ImpersonationWatchlistError extends Error {}

export type WatchlistEntry = {
  id: string;
  guildId: string;
  label: string;
  targetUserId: string | null;
  name: string;
  avatarHash: string | null;
  addedBy: string;
  createdAt: number;
};

function toEntry(row: typeof impersonationWatchlist.$inferSelect): WatchlistEntry {
  return {
    id: row.id,
    guildId: row.guildId,
    label: row.label,
    targetUserId: row.targetUserId,
    name: row.name,
    avatarHash: row.avatarHash,
    addedBy: row.addedBy,
    createdAt: row.createdAt.getTime(),
  };
}

export async function listWatchlist(guildId: string): Promise<WatchlistEntry[]> {
  const rows = await getDb()
    .select()
    .from(impersonationWatchlist)
    .where(eq(impersonationWatchlist.guildId, guildId))
    .orderBy(desc(impersonationWatchlist.createdAt))
    .all();
  return rows.map(toEntry);
}

/** Add a watchlist entry. Either pin a real member (`targetUserId` — name/avatar are looked
 * up live at detection time, no need to keep them in sync here) or a manual identity (name
 * plus an optional image to fingerprint, for protecting a name/persona with no real account). */
export async function addWatchlistEntry(input: {
  guildId: string;
  label: string;
  addedBy: string;
  targetUserId?: string;
  name?: string;
  imageBuffer?: Buffer;
  phash?: string;
}): Promise<WatchlistEntry> {
  const label = input.label.trim().slice(0, 200);
  if (!label) throw new ImpersonationWatchlistError("A label is required.");

  let avatarHash: string | null = null;
  if (input.phash) {
    if (!isValidPhash(input.phash)) {
      throw new ImpersonationWatchlistError("phash must be 16 hex characters (a 64-bit dHash).");
    }
    avatarHash = input.phash.toLowerCase();
  } else if (input.imageBuffer) {
    try {
      avatarHash = await computeDHash(input.imageBuffer);
    } catch {
      throw new ImpersonationWatchlistError("Could not read that as an image.");
    }
  }

  if (!input.targetUserId && !input.name?.trim() && !avatarHash) {
    throw new ImpersonationWatchlistError(
      "Pin a real member, or give the manual entry a name and/or an image to protect.",
    );
  }

  const row = {
    id: randomUUID(),
    guildId: input.guildId,
    label,
    targetUserId: input.targetUserId?.trim() || null,
    name: input.name?.trim().slice(0, 100) ?? "",
    avatarHash,
    addedBy: input.addedBy,
    createdAt: new Date(),
  };
  await getDb().insert(impersonationWatchlist).values(row);
  return toEntry(row);
}

export async function removeWatchlistEntry(guildId: string, id: string): Promise<boolean> {
  const result = await getDb()
    .delete(impersonationWatchlist)
    .where(and(eq(impersonationWatchlist.guildId, guildId), eq(impersonationWatchlist.id, id)))
    .run();
  return (result.changes ?? 0) > 0;
}

/** Downloads and hashes an avatar image straight from a Discord CDN URL (used both for
 * pinning a member's current look at add-time and for live re-checks). Never throws. */
export async function hashAvatarUrl(url: string): Promise<string | null> {
  const buffer = await fetchImageBuffer(url);
  if (!buffer) return null;
  try {
    return await computeDHash(buffer);
  } catch {
    return null;
  }
}
