import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { radioStations, radioTracks, radioStationState, radioUploads } from "../../../db/schema.js";
import { deletePageAsset, GLOBAL_ASSET_KEY, registerAssetKeeper } from "../../../core/pageAssets.js";

/** Stations and their songs (YouTube videos; legacy MP3 uploads live at data/radio/<station>/<track>.mp3). */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const RADIO_ROOT = join(ROOT, "data", "radio");
export const RADIO_TMP = join(RADIO_ROOT, "tmp");

export type RadioStationRow = typeof radioStations.$inferSelect;
export type RadioTrackRow = typeof radioTracks.$inferSelect;

export const RADIO_VISIBILITIES = ["draft", "live"] as const;
export type RadioVisibility = (typeof RADIO_VISIBILITIES)[number];

export const RADIO_LIMITS = {
  name: 60,
  description: 500,
  genre: 40,
  title: 200,
  artist: 200,
  stations: 100,
  tracksPerStation: 1000,
} as const;

const ID = /^[a-z0-9]{8,32}$/;

export function isRadioId(value: string): boolean {
  return ID.test(value);
}

export function newRadioId(): string {
  return randomBytes(8).toString("hex");
}

export function stationDir(stationId: string): string {
  if (!isRadioId(stationId)) throw new Error("Invalid station id");
  return join(RADIO_ROOT, stationId);
}

export function trackFilePath(stationId: string, trackId: string): string {
  if (!isRadioId(trackId)) throw new Error("Invalid track id");
  return join(stationDir(stationId), `${trackId}.mp3`);
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "station";
}

export async function listStations(): Promise<RadioStationRow[]> {
  return getDb().select().from(radioStations).orderBy(asc(radioStations.sortOrder), asc(radioStations.createdAt)).all();
}

export async function getStation(id: string): Promise<RadioStationRow | undefined> {
  if (!isRadioId(id)) return undefined;
  return getDb().select().from(radioStations).where(eq(radioStations.id, id)).get();
}

export async function listTracks(stationId: string): Promise<RadioTrackRow[]> {
  return getDb().select().from(radioTracks).where(eq(radioTracks.stationId, stationId)).orderBy(asc(radioTracks.position)).all();
}

export async function listAllTracks(): Promise<RadioTrackRow[]> {
  return getDb().select().from(radioTracks).orderBy(asc(radioTracks.position)).all();
}

export async function getTrack(stationId: string, trackId: string): Promise<RadioTrackRow | undefined> {
  if (!isRadioId(trackId)) return undefined;
  return getDb()
    .select()
    .from(radioTracks)
    .where(and(eq(radioTracks.stationId, stationId), eq(radioTracks.id, trackId)))
    .get();
}

async function uniqueSlug(name: string, exceptId?: string): Promise<string> {
  const base = slugify(name);
  const taken = new Set((await listStations()).filter((s) => s.id !== exceptId).map((s) => s.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
  return `${base}-${newRadioId().slice(0, 6)}`;
}

export type StationInput = {
  name?: string;
  description?: string;
  genre?: string | null;
  accentColor?: string | null;
  shuffle?: boolean;
  visibility?: RadioVisibility;
  sortOrder?: number;
};

export async function createStation(input: StationInput & { name: string }, actorId: string): Promise<RadioStationRow> {
  const now = new Date();
  const count = (await listStations()).length;
  if (count >= RADIO_LIMITS.stations) throw new Error(`You can have up to ${RADIO_LIMITS.stations} stations.`);
  const row: RadioStationRow = {
    id: newRadioId(),
    slug: await uniqueSlug(input.name),
    name: input.name,
    description: input.description ?? "",
    genre: input.genre ?? null,
    accentColor: input.accentColor ?? null,
    iconAssetId: null,
    shuffle: input.shuffle ?? false,
    visibility: input.visibility ?? "draft",
    sortOrder: input.sortOrder ?? count,
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  };
  await getDb().insert(radioStations).values(row);
  mkdirSync(stationDir(row.id), { recursive: true });
  return row;
}

export async function updateStation(id: string, input: StationInput & { iconAssetId?: string | null }): Promise<RadioStationRow | undefined> {
  const existing = await getStation(id);
  if (!existing) return undefined;
  const patch: Partial<RadioStationRow> = { updatedAt: new Date() };
  if (input.name !== undefined && input.name !== existing.name) {
    patch.name = input.name;
    patch.slug = await uniqueSlug(input.name, id);
  }
  if (input.description !== undefined) patch.description = input.description;
  if (input.genre !== undefined) patch.genre = input.genre;
  if (input.accentColor !== undefined) patch.accentColor = input.accentColor;
  if (input.shuffle !== undefined) patch.shuffle = input.shuffle;
  if (input.visibility !== undefined) patch.visibility = input.visibility;
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
  if (input.iconAssetId !== undefined) patch.iconAssetId = input.iconAssetId;
  await getDb().update(radioStations).set(patch).where(eq(radioStations.id, id));
  return getStation(id);
}

/** Deletes the station, its tracks, files, artwork, uploads and clock. */
export async function deleteStation(id: string): Promise<boolean> {
  const existing = await getStation(id);
  if (!existing) return false;
  const tracks = await listTracks(id);
  const db = getDb();
  await db.delete(radioTracks).where(eq(radioTracks.stationId, id));
  await db.delete(radioStationState).where(eq(radioStationState.stationId, id));
  await db.delete(radioUploads).where(eq(radioUploads.stationId, id));
  await db.delete(radioStations).where(eq(radioStations.id, id));
  for (const track of tracks) {
    if (track.artworkAssetId) deletePageAsset(GLOBAL_ASSET_KEY, "radio", track.artworkAssetId);
  }
  if (existing.iconAssetId) deletePageAsset(GLOBAL_ASSET_KEY, "radio", existing.iconAssetId);
  try {
    rmSync(stationDir(id), { recursive: true, force: true });
  } catch {
    // Best effort.
  }
  return true;
}

export async function insertTrack(row: RadioTrackRow): Promise<void> {
  await getDb().insert(radioTracks).values(row);
}

export async function updateTrackMeta(stationId: string, trackId: string, patch: { title?: string; artist?: string | null }): Promise<void> {
  const set: Partial<RadioTrackRow> = {};
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.artist !== undefined) set.artist = patch.artist;
  if (Object.keys(set).length === 0) return;
  await getDb()
    .update(radioTracks)
    .set(set)
    .where(and(eq(radioTracks.stationId, stationId), eq(radioTracks.id, trackId)));
}

/** Rewrites positions to match `order` (every track id of the station, in the new order). */
export async function reorderTracks(stationId: string, order: string[]): Promise<boolean> {
  const tracks = await listTracks(stationId);
  const ids = new Set(tracks.map((t) => t.id));
  if (order.length !== ids.size || new Set(order).size !== order.length || !order.every((id) => ids.has(id))) return false;
  const db = getDb();
  for (const [position, id] of order.entries()) {
    await db
      .update(radioTracks)
      .set({ position })
      .where(and(eq(radioTracks.stationId, stationId), eq(radioTracks.id, id)));
  }
  return true;
}

export async function removeTrack(stationId: string, trackId: string): Promise<boolean> {
  const track = await getTrack(stationId, trackId);
  if (!track) return false;
  await getDb()
    .delete(radioTracks)
    .where(and(eq(radioTracks.stationId, stationId), eq(radioTracks.id, trackId)));
  if (track.artworkAssetId) deletePageAsset(GLOBAL_ASSET_KEY, "radio", track.artworkAssetId);
  try {
    const path = trackFilePath(stationId, trackId);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best effort.
  }
  return true;
}

export async function stationStorageBytes(stationId: string): Promise<number> {
  return (await listTracks(stationId)).reduce((sum, t) => sum + t.sizeBytes, 0);
}

export async function totalStorageBytes(): Promise<number> {
  return (await listAllTracks()).reduce((sum, t) => sum + t.sizeBytes, 0);
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// Station icons and track artwork share the global "radio" page-asset folder; keep them all.
let keptAssetIds: string[] = [];
registerAssetKeeper("radio", () => keptAssetIds);

export async function refreshKeptRadioAssets(): Promise<void> {
  const stations = await listStations();
  const tracks = await listAllTracks();
  keptAssetIds = [
    ...stations.map((s) => s.iconAssetId).filter((id): id is string => Boolean(id)),
    ...tracks.map((t) => t.artworkAssetId).filter((id): id is string => Boolean(id)),
  ];
}
