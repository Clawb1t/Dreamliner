import type { Track } from "lavalink-client";
import { getLogger } from "../core/logger.js";
import { getLavalinkManager, isLavalinkConfigured } from "../plugins/music/functions/manager.js";
import {
  addTrackToPlaylist,
  deletePlaylist,
  getPlaylist,
  getPlaylistTracks,
  listPlaylists,
  normalizePlaylistName,
  removeTrackFromPlaylist,
  renamePlaylist,
  savePlaylist,
  type PlaylistRow,
  type PlaylistTrackRow,
} from "../plugins/music/functions/playlistStore.js";

const log = getLogger("bridge");

const MAX_PLAYLISTS_PER_USER = 25;
const MAX_PLAYLIST_TRACKS = 200;

export type WebPlaylistTrack = {
  id: number;
  encoded: string | null;
  title: string;
  author: string | null;
  uri: string | null;
  artworkUrl: string | null;
  durationMs: number;
};

export type WebPlaylist = {
  id: number;
  name: string;
  trackCount: number;
  durationMs: number;
  updatedAt: string;
};

export type WebPlaylistDetail = WebPlaylist & { tracks: WebPlaylistTrack[] };

export type WebPlaylistTrackInput = {
  encoded: string | null;
  title: string;
  author: string | null;
  uri: string | null;
  artworkUrl: string | null;
  durationMs: number;
};

function toWebPlaylist(row: PlaylistRow, tracks: PlaylistTrackRow[]): WebPlaylist {
  return {
    id: row.id,
    name: row.name,
    trackCount: tracks.length,
    durationMs: tracks.reduce((sum, t) => sum + t.durationMs, 0),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toWebPlaylistTrack(row: PlaylistTrackRow): WebPlaylistTrack {
  return {
    id: row.id,
    encoded: row.encoded,
    title: row.title,
    author: row.artist,
    uri: row.uri,
    artworkUrl: row.artworkUrl,
    durationMs: row.durationMs,
  };
}

/** Reconstructs a minimal Lavalink Track from a web-supplied track input — same shape webMusic.ts's
 *  fromWebTrack builds, just without a real requester (playlists aren't tied to a queue action). */
function toLavalinkTrack(input: WebPlaylistTrackInput): Track {
  return {
    encoded: input.encoded ?? "",
    info: {
      identifier: input.encoded ?? "",
      title: input.title,
      author: input.author ?? "",
      duration: input.durationMs,
      artworkUrl: input.artworkUrl,
      uri: input.uri ?? "",
      sourceName: "http" as Track["info"]["sourceName"],
      isSeekable: true,
      isStream: false,
      isrc: null,
    },
    pluginInfo: {},
    requester: { id: "" },
  };
}

export async function listWebPlaylists(userId: string): Promise<WebPlaylist[]> {
  const rows = await listPlaylists(userId);
  return Promise.all(rows.map(async (row) => toWebPlaylist(row, await getPlaylistTracks(row.id))));
}

export async function getWebPlaylist(userId: string, name: string): Promise<WebPlaylistDetail | null> {
  const row = await getPlaylist(userId, name);
  if (!row) return null;
  const tracks = await getPlaylistTracks(row.id);
  return { ...toWebPlaylist(row, tracks), tracks: tracks.map(toWebPlaylistTrack) };
}

export type WebPlaylistResult =
  | { ok: true; playlist: WebPlaylistDetail }
  | { ok: false; status: number; error: string };

export async function createWebPlaylist(
  userId: string,
  name: string,
  tracks: WebPlaylistTrackInput[],
): Promise<WebPlaylistResult> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, status: 400, error: "Give the playlist a name." };
  if (tracks.length === 0) return { ok: false, status: 400, error: "Add at least one track." };
  if (tracks.length > MAX_PLAYLIST_TRACKS) {
    return { ok: false, status: 400, error: `A playlist can hold at most ${MAX_PLAYLIST_TRACKS} tracks.` };
  }
  const existing = await listPlaylists(userId);
  if (existing.length >= MAX_PLAYLISTS_PER_USER) {
    return { ok: false, status: 400, error: `You can save at most ${MAX_PLAYLISTS_PER_USER} playlists.` };
  }

  const result = await savePlaylist(userId, trimmed, tracks.map(toLavalinkTrack));
  if (!result.ok) {
    return {
      ok: false,
      status: 409,
      error: `You already have a playlist named "${normalizePlaylistName(trimmed)}".`,
    };
  }
  const detail = await getWebPlaylist(userId, trimmed);
  if (!detail) return { ok: false, status: 500, error: "Playlist saved but couldn't be reloaded." };
  return { ok: true, playlist: detail };
}

export async function deleteWebPlaylist(
  userId: string,
  name: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const result = await deletePlaylist(userId, name);
  if (!result.ok) return { ok: false, status: 404, error: "Playlist not found." };
  return { ok: true };
}

export async function renameWebPlaylist(
  userId: string,
  oldName: string,
  newName: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!newName.trim()) return { ok: false, status: 400, error: "Give the playlist a name." };
  const result = await renamePlaylist(userId, oldName, newName);
  if (!result.ok) {
    return result.reason === "not_found"
      ? { ok: false, status: 404, error: "Playlist not found." }
      : { ok: false, status: 409, error: "You already have a playlist with that name." };
  }
  return { ok: true };
}

export async function addWebPlaylistTrack(
  userId: string,
  name: string,
  track: WebPlaylistTrackInput,
): Promise<WebPlaylistResult> {
  const playlist = await getPlaylist(userId, name);
  if (!playlist) return { ok: false, status: 404, error: "Playlist not found." };
  const tracks = await getPlaylistTracks(playlist.id);
  if (tracks.length >= MAX_PLAYLIST_TRACKS) {
    return { ok: false, status: 400, error: `A playlist can hold at most ${MAX_PLAYLIST_TRACKS} tracks.` };
  }
  await addTrackToPlaylist(playlist.id, toLavalinkTrack(track));
  const detail = await getWebPlaylist(userId, name);
  if (!detail) return { ok: false, status: 500, error: "Couldn't reload the playlist." };
  return { ok: true, playlist: detail };
}

export async function removeWebPlaylistTrack(
  userId: string,
  name: string,
  trackId: number,
): Promise<WebPlaylistResult> {
  const playlist = await getPlaylist(userId, name);
  if (!playlist) return { ok: false, status: 404, error: "Playlist not found." };
  await removeTrackFromPlaylist(playlist.id, trackId);
  const detail = await getWebPlaylist(userId, name);
  if (!detail) return { ok: false, status: 500, error: "Couldn't reload the playlist." };
  return { ok: true, playlist: detail };
}

export type WebPlaylistSearchTrack = {
  encoded: string;
  title: string;
  author: string | null;
  uri: string | null;
  artworkUrl: string | null;
  durationMs: number;
  sourceName: string;
};

/** Search for tracks to build a playlist with — deliberately NOT tied to any guild's active
 *  player (unlike the guild music player's own search), since playlist management lives on the
 *  account page with no guild/voice context at all. Picks any connected Lavalink node directly. */
export async function searchForPlaylist(
  query: string,
): Promise<{ tracks: WebPlaylistSearchTrack[] } | { error: string; status: number }> {
  if (!isLavalinkConfigured()) return { error: "Music isn't configured on this bot yet.", status: 503 };
  const trimmed = query.trim();
  if (!trimmed) return { tracks: [] };

  const node = getLavalinkManager().nodeManager.leastUsedNodes()[0];
  if (!node) return { error: "No music node is connected right now.", status: 503 };

  try {
    const result = await node.search({ query: trimmed }, { id: "web" });
    if (result.loadType === "error" || result.loadType === "empty") return { tracks: [] };
    const resolved = result.tracks.filter((t): t is Track => !("resolve" in t));
    return {
      tracks: resolved.slice(0, 10).map((t) => ({
        encoded: t.encoded ?? "",
        title: t.info.title,
        author: t.info.author || null,
        uri: t.info.uri || null,
        artworkUrl: t.info.artworkUrl,
        durationMs: t.info.duration,
        sourceName: t.info.sourceName,
      })),
    };
  } catch (error) {
    log.error("Playlist search failed:", error);
    return { error: "Search failed.", status: 502 };
  }
}
