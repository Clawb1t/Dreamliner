import type { LavalinkManager, Player, Track } from "lavalink-client";
import { getLogger } from "../../../core/logger.js";
import { getSiteUrl } from "../../../core/docsUrl.js";
import { getLavalinkManager, isLavalinkConfigured } from "../functions/manager.js";
import { getLive, onStationChange, type RadioLive } from "./clock.js";
import { signedRadioUrl } from "./media.js";
import { currentStationId, leadingLiveCount, radioTag, type RadioTag } from "./tags.js";
import type { RadioStationRow, RadioTrackRow } from "./store.js";

/**
 * Plays stations through the normal Lavalink player:
 *  - A station's songs are ordinary tracks tagged with `userData.radio`. While one is on air, the
 *    station's next song is kept at the front of the queue ("live" entries) so autoSkip carries
 *    straight on, and every song start re-syncs to the station's global clock.
 *  - Tuning in while music is playing adds a "ticket" entry to the end of the queue. When the
 *    ticket comes up it swaps itself for whatever the station is playing at that moment.
 */

const log = getLogger("music");
const DRIFT_TOLERANCE_MS = 3000;

export { radioTag, currentStationId, type RadioTag } from "./tags.js";

export function radioIconUrl(station: RadioStationRow, absolute = false): string | null {
  if (!station.iconAssetId) return null;
  return `${absolute ? getSiteUrl() : ""}/api/radios/${station.id}/media/icon?v=${station.iconAssetId}`;
}

export function radioArtworkUrl(stationId: string, track: RadioTrackRow, absolute = false): string | null {
  if (!track.artworkAssetId) return null;
  return `${absolute ? getSiteUrl() : ""}/api/radios/${stationId}/media/artwork/${track.id}?v=${track.artworkAssetId}`;
}

function requesterFor(player: Player, fallback?: string): { id: string } | undefined {
  const id = fallback ?? player.getData<string | undefined>("radioRequester");
  return id ? { id } : undefined;
}

/** Loads one station song into Lavalink and dresses it with the station's details. */
async function resolveRadioTrack(
  player: Player,
  station: RadioStationRow,
  track: RadioTrackRow,
  kind: RadioTag["kind"],
  requester?: { id: string },
): Promise<Track> {
  const result = await player.search({ query: signedRadioUrl(station.id, track.id) }, requester);
  const loaded = result.tracks.find((t): t is Track => !("resolve" in t));
  if (!loaded) throw new Error(`Lavalink couldn't load radio track ${track.id} (${result.loadType}).`);
  loaded.info = {
    ...loaded.info,
    title: track.title,
    author: track.artist ? `${track.artist} · ${station.name}` : station.name,
    duration: track.durationMs || loaded.info.duration,
    artworkUrl: radioArtworkUrl(station.id, track, true) ?? radioIconUrl(station, true),
    // The real URI is the signed internal media link; never show it anywhere.
    uri: "",
    isSeekable: true,
    isStream: false,
  };
  loaded.requester = requester;
  loaded.userData = { ...(loaded.userData ?? {}), radio: { stationId: station.id, stationName: station.name, trackId: track.id, kind } satisfies RadioTag };
  return loaded;
}

async function dropLeadingLive(player: Player): Promise<void> {
  const count = leadingLiveCount(player);
  if (count > 0) await player.queue.splice(0, count);
}

/** Keeps exactly one "live" entry (the station's next song) at the front of the queue. */
async function ensureNext(player: Player, live: RadioLive): Promise<void> {
  await dropLeadingLive(player);
  if (!live.next) return;
  const next = await resolveRadioTrack(player, live.station, live.next, "live", requesterFor(player));
  await player.queue.add(next, 0);
}

const busy = new Set<string>();

/** Plays whatever `stationId` is playing right now, at the live point, replacing the current track. */
export async function playLive(player: Player, stationId: string, requesterId?: string): Promise<boolean> {
  const live = getLive(stationId);
  if (!live) return false;
  if (requesterId) player.setData("radioRequester", requesterId);
  const track = await resolveRadioTrack(player, live.station, live.track, "live", requesterFor(player, requesterId));
  if (player.repeatMode !== "off") await player.setRepeatMode("off");
  busy.add(player.guildId);
  try {
    await player.play({ track, position: Math.round(live.offsetMs), paused: false });
    await ensureNext(player, live);
  } finally {
    busy.delete(player.guildId);
  }
  return true;
}

export type TuneResult = { ok: true; started: boolean } | { ok: false; error: string };

/**
 * Tunes this server's player to a station. Starts now if nothing (or another station) is
 * playing; otherwise queues the station as one entry after the current queue.
 */
export async function tuneIn(player: Player, stationId: string, requesterId: string): Promise<TuneResult> {
  const live = getLive(stationId);
  if (!live || live.station.visibility !== "live") return { ok: false, error: "That station isn't on air right now." };
  const current = player.queue.current;
  if (radioTag(current)?.stationId === stationId) return { ok: false, error: `You're already tuned to ${live.station.name}.` };

  const idle = !current || radioTag(current) !== null;
  if (idle) {
    // Switching stations, or nothing playing: go live straight away.
    if (radioTag(current)) await dropLeadingLive(player);
    await playLive(player, stationId, requesterId);
    return { ok: true, started: true };
  }
  const ticket = await resolveRadioTrack(player, live.station, live.track, "ticket", { id: requesterId });
  await player.queue.add(ticket);
  return { ok: true, started: false };
}

/** Leaves the station that's on air and moves on to the next queued song (or goes quiet). */
export async function leaveRadio(player: Player): Promise<boolean> {
  if (!currentStationId(player)) return false;
  await dropLeadingLive(player);
  player.setData("radioRequester", undefined);
  if (player.queue.tracks.length > 0) await player.skip();
  else await player.stopPlaying(false, false);
  return true;
}

/** /skip and the web Skip button: on a station, skipping means leaving it. */
export async function skipOrLeaveRadio(player: Player): Promise<void> {
  if (await leaveRadio(player)) return;
  await player.skip();
}

/** How many servers are tuned to each station right now. */
export function listenerCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  if (!isLavalinkConfigured()) return counts;
  for (const player of getLavalinkManager().players.values()) {
    const id = currentStationId(player);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Re-attaches a player that came back from a restart while a station was on air. */
export async function resumeRadio(player: Player, stationId: string): Promise<boolean> {
  try {
    return await playLive(player, stationId);
  } catch (error) {
    log.error(`Failed to resume radio station ${stationId} in guild ${player.guildId}:`, error);
    return false;
  }
}

async function onRadioTrackStart(player: Player, track: Track): Promise<void> {
  const tag = radioTag(track);
  if (!tag || busy.has(player.guildId)) return;
  const live = getLive(tag.stationId);
  if (!live || live.station.visibility !== "live") {
    // The station was deleted or taken off air while queued: move on.
    await dropLeadingLive(player);
    if (player.queue.tracks.length > 0) await player.skip();
    else await player.stopPlaying(false, false);
    return;
  }
  if (tag.kind === "ticket") player.setData("radioRequester", (track.requester as { id?: string } | undefined)?.id);
  if (tag.kind === "ticket" || tag.trackId !== live.track.id) {
    // A queued entry came up, or this server fell behind a song: jump to what's live.
    await playLive(player, tag.stationId);
    return;
  }
  if (Math.abs(player.position - live.offsetMs) > DRIFT_TOLERANCE_MS) await player.seek(Math.round(live.offsetMs));
  busy.add(player.guildId);
  try {
    await ensureNext(player, live);
  } finally {
    busy.delete(player.guildId);
  }
}

/** Brings one tuned-in server back in line: swap the song if it changed, else just refresh what's next. */
async function resyncPlayer(player: Player, stationId: string): Promise<void> {
  const live = getLive(stationId);
  if (!live || live.station.visibility !== "live") return;
  if (radioTag(player.queue.current)?.trackId !== live.track.id) {
    await playLive(player, stationId);
    return;
  }
  busy.add(player.guildId);
  try {
    await ensureNext(player, live);
  } finally {
    busy.delete(player.guildId);
  }
}

export function registerRadioEvents(manager: LavalinkManager): void {
  manager.on("trackStart", (player, track) => {
    if (!track || !radioTag(track)) return;
    void onRadioTrackStart(player, track).catch((error: unknown) =>
      log.error(`Radio track start handling failed in guild ${player.guildId}:`, error),
    );
  });

  // An operator skip or a track list change: bring every server on that station back in line.
  onStationChange((stationId) => {
    for (const player of manager.players.values()) {
      if (currentStationId(player) !== stationId) continue;
      void resyncPlayer(player, stationId).catch((error: unknown) =>
        log.error(`Radio re-sync failed for station ${stationId} in guild ${player.guildId}:`, error),
      );
    }
  });
}
