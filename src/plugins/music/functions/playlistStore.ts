import { and, eq } from "drizzle-orm";
import type { Track } from "lavalink-client";
import { getDb } from "../../../db/client.js";
import { musicPlaylists, musicPlaylistTracks } from "../../../db/schema.js";

export type PlaylistRow = { id: number; ownerId: string; name: string; createdAt: Date; updatedAt: Date };
export type PlaylistTrackRow = {
  id: number;
  playlistId: number;
  position: number;
  encoded: string | null;
  title: string;
  artist: string | null;
  uri: string | null;
  artworkUrl: string | null;
  durationMs: number;
};

export function normalizePlaylistName(name: string): string {
  return name.trim().toLowerCase().slice(0, 64);
}

export async function listPlaylists(ownerId: string): Promise<PlaylistRow[]> {
  return getDb().select().from(musicPlaylists).where(eq(musicPlaylists.ownerId, ownerId)).all();
}

export async function getPlaylist(ownerId: string, name: string): Promise<PlaylistRow | null> {
  const row = await getDb()
    .select()
    .from(musicPlaylists)
    .where(and(eq(musicPlaylists.ownerId, ownerId), eq(musicPlaylists.name, normalizePlaylistName(name))))
    .get();
  return row ?? null;
}

export async function getPlaylistTracks(playlistId: number): Promise<PlaylistTrackRow[]> {
  return getDb()
    .select()
    .from(musicPlaylistTracks)
    .where(eq(musicPlaylistTracks.playlistId, playlistId))
    .orderBy(musicPlaylistTracks.position)
    .all();
}

export type SavePlaylistResult = { ok: true; playlist: PlaylistRow } | { ok: false; reason: "already_exists" };

/** Creates a new playlist named `name` for `ownerId`, snapshotting `tracks` in order. */
export async function savePlaylist(ownerId: string, name: string, tracks: Track[]): Promise<SavePlaylistResult> {
  const normalized = normalizePlaylistName(name);
  const db = getDb();
  const existing = await getPlaylist(ownerId, normalized);
  if (existing) return { ok: false, reason: "already_exists" };

  const now = new Date();
  const playlist = await db
    .insert(musicPlaylists)
    .values({ ownerId, name: normalized, createdAt: now, updatedAt: now })
    .returning()
    .get();

  if (tracks.length > 0) {
    await db.insert(musicPlaylistTracks).values(
      tracks.map((track, index) => ({
        playlistId: playlist.id,
        position: index,
        encoded: track.encoded ?? null,
        title: track.info.title,
        artist: track.info.author ?? null,
        uri: track.info.uri ?? null,
        artworkUrl: track.info.artworkUrl ?? null,
        durationMs: track.info.duration,
        addedAt: now,
      })),
    );
  }

  return { ok: true, playlist };
}

export type DeleteResult = { ok: true } | { ok: false; reason: "not_found" };

export async function deletePlaylist(ownerId: string, name: string): Promise<DeleteResult> {
  const playlist = await getPlaylist(ownerId, name);
  if (!playlist) return { ok: false, reason: "not_found" };
  const db = getDb();
  await db.delete(musicPlaylistTracks).where(eq(musicPlaylistTracks.playlistId, playlist.id));
  await db.delete(musicPlaylists).where(eq(musicPlaylists.id, playlist.id));
  return { ok: true };
}

export type RenameResult = { ok: true } | { ok: false; reason: "not_found" | "already_exists" };

export async function renamePlaylist(ownerId: string, oldName: string, newName: string): Promise<RenameResult> {
  const playlist = await getPlaylist(ownerId, oldName);
  if (!playlist) return { ok: false, reason: "not_found" };
  const normalized = normalizePlaylistName(newName);
  const conflict = await getPlaylist(ownerId, normalized);
  // A no-op case-only rename (e.g. "chill" -> "Chill") normalizes to the playlist's own current
  // name, so it always finds itself here — that's not a real conflict, just nothing to do.
  if (conflict && conflict.id !== playlist.id) return { ok: false, reason: "already_exists" };
  await getDb()
    .update(musicPlaylists)
    .set({ name: normalized, updatedAt: new Date() })
    .where(eq(musicPlaylists.id, playlist.id));
  return { ok: true };
}

/** Appends one track to an already-saved playlist — for editing after the fact (the web player's
 *  "add more tracks" flow), rather than only ever snapshotting a whole list at creation time. */
export async function addTrackToPlaylist(playlistId: number, track: Track): Promise<PlaylistTrackRow> {
  const db = getDb();
  const existing = await getPlaylistTracks(playlistId);
  const now = new Date();
  const row = await db
    .insert(musicPlaylistTracks)
    .values({
      playlistId,
      position: existing.length,
      encoded: track.encoded ?? null,
      title: track.info.title,
      artist: track.info.author ?? null,
      uri: track.info.uri ?? null,
      artworkUrl: track.info.artworkUrl ?? null,
      durationMs: track.info.duration,
      addedAt: now,
    })
    .returning()
    .get();
  await db.update(musicPlaylists).set({ updatedAt: now }).where(eq(musicPlaylists.id, playlistId));
  return row;
}

export async function removeTrackFromPlaylist(playlistId: number, trackId: number): Promise<void> {
  const db = getDb();
  await db
    .delete(musicPlaylistTracks)
    .where(and(eq(musicPlaylistTracks.id, trackId), eq(musicPlaylistTracks.playlistId, playlistId)));
  await db.update(musicPlaylists).set({ updatedAt: new Date() }).where(eq(musicPlaylists.id, playlistId));
}
