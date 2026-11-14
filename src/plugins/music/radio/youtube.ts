import type { Track } from "lavalink-client";
import { getLavalinkManager, isLavalinkConfigured } from "../functions/manager.js";
import { insertTrack, listTracks, newRadioId, RADIO_LIMITS, type RadioTrackRow } from "./store.js";

/**
 * Operators add songs to a station by pasting a YouTube video or playlist link. Each video is
 * resolved once through Lavalink and its encoded track stored, so the station can replay it later
 * without searching.
 */

export const RADIO_MAX_TRACK_MS = 3 * 60 * 60 * 1000;

export class RadioAddError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

/** Only plain YouTube links, so this can't be used to make Lavalink fetch arbitrary URLs. */
export function normalizeYoutubeUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
  url.protocol = "https:";
  return url.toString();
}

function thumbnail(track: Track): string | null {
  if (track.info.artworkUrl) return track.info.artworkUrl;
  return /^[\w-]{11}$/.test(track.info.identifier) ? `https://i.ytimg.com/vi/${track.info.identifier}/hqdefault.jpg` : null;
}

export async function addYoutubeTracks(
  stationId: string,
  input: string,
  actorId: string,
): Promise<{ added: RadioTrackRow[]; skipped: number }> {
  const url = normalizeYoutubeUrl(input);
  if (!url) throw new RadioAddError("Paste a YouTube video or playlist link.");
  if (!isLavalinkConfigured()) throw new RadioAddError("Music isn't configured on this bot yet.", 503);
  const node = getLavalinkManager().nodeManager.leastUsedNodes("playingPlayers")[0];
  if (!node) throw new RadioAddError("The music server is offline. Try again in a moment.", 503);

  let result: Awaited<ReturnType<typeof node.search>>;
  try {
    result = await node.search({ query: url }, { id: actorId });
  } catch {
    throw new RadioAddError("Couldn't reach YouTube. Try again in a moment.", 502);
  }
  if (result.loadType === "error") throw new RadioAddError("YouTube wouldn't load that link. It may be private or removed.");
  const tracks = result.tracks.filter((t): t is Track => !("resolve" in t) && Boolean(t.encoded));
  // A plain search result isn't what was asked for; a link should load a track or a playlist.
  if (result.loadType === "search" || tracks.length === 0) throw new RadioAddError("Nothing was found at that link.");

  const existing = await listTracks(stationId);
  const known = new Set(existing.map((t) => t.sourceUrl).filter(Boolean));
  let position = existing.reduce((max, t) => Math.max(max, t.position + 1), 0);
  const room = RADIO_LIMITS.tracksPerStation - existing.length;
  if (room <= 0) throw new RadioAddError(`A station can have up to ${RADIO_LIMITS.tracksPerStation} songs.`);

  const added: RadioTrackRow[] = [];
  let skipped = 0;
  for (const track of tracks) {
    const sourceUrl = track.info.uri || `https://www.youtube.com/watch?v=${track.info.identifier}`;
    const tooLong = track.info.duration > RADIO_MAX_TRACK_MS;
    if (track.info.isStream || tooLong || !track.info.duration || known.has(sourceUrl) || added.length >= room) {
      skipped++;
      continue;
    }
    known.add(sourceUrl);
    const row: RadioTrackRow = {
      id: newRadioId(),
      stationId,
      position: position++,
      title: (track.info.title || "Untitled").slice(0, RADIO_LIMITS.title),
      artist: track.info.author?.slice(0, RADIO_LIMITS.artist) || null,
      durationMs: Math.round(track.info.duration),
      sizeBytes: 0,
      sha256: `yt:${track.info.identifier}`,
      artworkAssetId: null,
      sourceUrl,
      encoded: track.encoded!,
      artworkUrl: thumbnail(track),
      createdBy: actorId,
      createdAt: new Date(),
    };
    await insertTrack(row);
    added.push(row);
  }
  if (added.length === 0) {
    throw new RadioAddError(
      skipped ? "Nothing new to add: those videos are already on the station, live streams, or over 3 hours." : "Nothing was found at that link.",
    );
  }
  return { added, skipped };
}
