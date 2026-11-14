import type { Guild } from "discord.js";
import { configManager } from "../config/manager.js";
import { pluginEnabled } from "../core/pluginCommand.js";
import { getPluginSettings, resolveEffectivePluginConfig } from "../core/permissionRoles.js";
import { decodeBase64Upload, GLOBAL_ASSET_KEY, readPageAsset, savePageAsset } from "../core/pageAssets.js";
import { zMusicConfig } from "../config/schemas/music.js";
import { getExistingPlayer, isLavalinkConfigured } from "../plugins/music/functions/manager.js";
import { getOrConnectPlayer } from "../plugins/music/functions/player.js";
import { musicChannelBlock } from "../plugins/music/functions/limits.js";
import { saveSessionNow } from "../plugins/music/functions/sessionPersistence.js";
import { canBypassVoteSkip } from "../plugins/music/functions/permissions.js";
import { clearVotes, registerVote, requiredVotes } from "../plugins/music/functions/voteSkip.js";
import { logMusic } from "../plugins/music/functions/musicLog.js";
import { forgetStationClock, getLive, liveStations, moveOffTrack, refreshStationClock, skipStation, stationTrackCount } from "../plugins/music/radio/clock.js";
import { leaveRadio, listenerCounts, radioArtworkUrl, radioIconUrl, tuneIn } from "../plugins/music/radio/controller.js";
import { currentStationId } from "../plugins/music/radio/tags.js";
import {
  RADIO_LIMITS,
  RADIO_VISIBILITIES,
  createStation,
  deleteStation,
  getStation,
  listStations,
  listTracks,
  radioStorageLimitBytes,
  refreshKeptRadioAssets,
  removeTrack,
  reorderTracks,
  totalStorageBytes,
  updateStation,
  updateTrackMeta,
  type RadioStationRow,
  type RadioTrackRow,
  type StationInput,
} from "../plugins/music/radio/store.js";
import { abortUpload, appendChunk, completeUpload, RadioUploadError, startUpload } from "../plugins/music/radio/uploads.js";

// ---------------------------------------------------------------------------------------------
// Shapes the website reads (see the website's botBridge.ts).

export type RadioNowPlaying = {
  trackId: string;
  title: string;
  artist: string | null;
  durationMs: number;
  positionMs: number;
  artworkUrl: string | null;
};

export type RadioStationPublic = {
  id: string;
  slug: string;
  name: string;
  description: string;
  genre: string | null;
  accentColor: string | null;
  iconUrl: string | null;
  trackCount: number;
  totalDurationMs: number;
  nowPlaying: RadioNowPlaying | null;
  listeners: number;
};

export type RadioTrackAdmin = {
  id: string;
  position: number;
  title: string;
  artist: string | null;
  durationMs: number;
  sizeBytes: number;
  artworkUrl: string | null;
  createdAt: string;
};

export type RadioStationAdmin = RadioStationPublic & {
  visibility: "draft" | "live";
  shuffle: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  storageBytes: number;
  tracks: RadioTrackAdmin[];
};

type Result<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };

function nowPlaying(stationId: string): RadioNowPlaying | null {
  const live = getLive(stationId);
  if (!live) return null;
  return {
    trackId: live.track.id,
    title: live.track.title,
    artist: live.track.artist,
    durationMs: live.track.durationMs,
    positionMs: Math.round(live.offsetMs),
    artworkUrl: radioArtworkUrl(stationId, live.track) ?? radioIconUrl(live.station),
  };
}

function toPublic(station: RadioStationRow, counts: Map<string, number>): RadioStationPublic {
  const { count, totalMs } = stationTrackCount(station.id);
  return {
    id: station.id,
    slug: station.slug,
    name: station.name,
    description: station.description,
    genre: station.genre,
    accentColor: station.accentColor,
    iconUrl: radioIconUrl(station),
    trackCount: count,
    totalDurationMs: totalMs,
    nowPlaying: nowPlaying(station.id),
    listeners: counts.get(station.id) ?? 0,
  };
}

function toTrackAdmin(track: RadioTrackRow): RadioTrackAdmin {
  return {
    id: track.id,
    position: track.position,
    title: track.title,
    artist: track.artist,
    durationMs: track.durationMs,
    sizeBytes: track.sizeBytes,
    artworkUrl: radioArtworkUrl(track.stationId, track),
    createdAt: track.createdAt.toISOString(),
  };
}

async function toAdmin(station: RadioStationRow, counts = listenerCounts()): Promise<RadioStationAdmin> {
  const tracks = await listTracks(station.id);
  return {
    ...toPublic(station, counts),
    trackCount: tracks.length,
    totalDurationMs: tracks.reduce((sum, t) => sum + t.durationMs, 0),
    visibility: station.visibility === "live" ? "live" : "draft",
    shuffle: station.shuffle,
    sortOrder: station.sortOrder,
    createdAt: station.createdAt.toISOString(),
    updatedAt: station.updatedAt.toISOString(),
    storageBytes: tracks.reduce((sum, t) => sum + t.sizeBytes, 0),
    tracks: tracks.map(toTrackAdmin),
  };
}

// ---------------------------------------------------------------------------------------------
// Guild endpoints (the music page's Radios section). Same gate as the rest of the web player.

async function loadAuth(guild: Guild, userId: string) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return { ok: false as const, status: 403, error: "You need to be a member of this server." };
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  if (!pluginEnabled(guildConfig, "music")) return { ok: false as const, status: 403, error: "Music is disabled on this server." };
  const config = zMusicConfig.parse(await resolveEffectivePluginConfig(guild.id, "music", member, guildConfig));
  return { ok: true as const, member, config, guildConfig };
}

export async function getGuildRadios(guild: Guild): Promise<{ enabled: boolean; stations: RadioStationPublic[]; tunedStationId: string | null }> {
  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const settings = zMusicConfig.parse(getPluginSettings(guildConfig, "music"));
  const counts = listenerCounts();
  return {
    enabled: pluginEnabled(guildConfig, "music") && settings.radios_enabled && isLavalinkConfigured(),
    stations: liveStations().map((s) => toPublic(s, counts)),
    tunedStationId: currentStationId(getExistingPlayer(guild.id)),
  };
}

export async function webTuneRadio(guild: Guild, userId: string, stationId: string): Promise<Result<{ started: boolean }>> {
  const auth = await loadAuth(guild, userId);
  if (!auth.ok) return auth;
  if (!auth.config.can_play) return { ok: false, status: 403, error: "You don't have permission to play music here." };
  if (!auth.config.radios_enabled) return { ok: false, status: 403, error: "Radio stations are turned off on this server." };
  if (!isLavalinkConfigured()) return { ok: false, status: 503, error: "Music isn't configured on this bot yet." };
  const live = getLive(stationId);
  if (!live || live.station.visibility !== "live") return { ok: false, status: 404, error: "That station isn't on air." };

  const voiceChannelId = auth.member.voice.channelId;
  if (!voiceChannelId) return { ok: false, status: 400, error: "Join a voice channel first." };
  const block = musicChannelBlock(auth.config, voiceChannelId);
  if (block) return { ok: false, status: 403, error: block };

  const textChannelId = auth.config.announce_channel_id || guild.systemChannelId || guild.id;
  const claim = await getOrConnectPlayer(guild.id, voiceChannelId, getExistingPlayer(guild.id)?.textChannelId ?? textChannelId, {
    member: auth.member,
    config: auth.config,
  });
  if (!claim.ok) {
    const error =
      claim.reason === "blocked_by_other"
        ? "Another feature is already using voice in this server."
        : claim.reason === "in_use_elsewhere"
          ? "People are listening in another voice channel. Join them, or ask a DJ to move the music."
          : "Couldn't connect to that voice channel.";
    return { ok: false, status: 409, error };
  }
  try {
    const result = await tuneIn(claim.player, stationId, userId);
    if (!result.ok) return { ok: false, status: 409, error: result.error };
    void saveSessionNow(claim.player).catch(() => {});
    void logMusic(guild.client, auth.guildConfig, guild.id, "music_play", result.started ? "Music - Radio Tuned In" : "Music - Radio Queued", [
      `By: <@${userId}>`,
      "Source: Web player",
      `Station: **${live.station.name}**`,
    ], { actorId: userId, channelId: voiceChannelId });
    return { ok: true, started: result.started };
  } catch {
    return { ok: false, status: 502, error: `Couldn't tune into ${live.station.name} right now.` };
  }
}

export type WebLeaveRadioResult =
  | { ok: true; left: true }
  | { ok: true; left: false; have: number; need: number; alreadyVoted: boolean }
  | { ok: false; status: number; error: string };

/** Same rules as /radio leave: DJs, force-skippers and whoever tuned in leave at once; others vote. */
export async function webLeaveRadio(guild: Guild, userId: string): Promise<WebLeaveRadioResult> {
  const player = getExistingPlayer(guild.id);
  const stationId = currentStationId(player);
  if (!player || !stationId) return { ok: false, status: 409, error: "No radio station is on air here." };
  const auth = await loadAuth(guild, userId);
  if (!auth.ok) return auth;
  if (!auth.config.can_skip) return { ok: false, status: 403, error: "You don't have permission to do that." };
  if (auth.member.voice.channelId !== player.voiceChannelId) {
    return { ok: false, status: 403, error: "You need to be in the voice channel to do that." };
  }
  const requesterId = (player.queue.current?.requester as { id?: string } | undefined)?.id;
  const bypass = canBypassVoteSkip(auth.member, auth.config, auth.config.can_force_skip) || requesterId === userId;
  if (!bypass) {
    const channel = auth.member.voice.channel;
    const nonBotCount = channel ? channel.members.filter((m) => !m.user.bot).size : 1;
    const need = requiredVotes(nonBotCount, auth.config.vote_skip_threshold_percent);
    const vote = registerVote(guild.id, `radio:${stationId}`, userId, need, auth.config.vote_skip_timeout_seconds * 1000);
    if (vote.status !== "skipped") return { ok: true, left: false, have: vote.have, need: vote.need, alreadyVoted: vote.status === "already_voted" };
  }
  clearVotes(guild.id);
  const name = getLive(stationId)?.station.name ?? "the station";
  await leaveRadio(player);
  void saveSessionNow(player).catch(() => {});
  void logMusic(guild.client, auth.guildConfig, guild.id, "music_skip", "Music - Left Radio", [
    `By: <@${userId}>`,
    "Source: Web player",
    `Station: **${name}**`,
  ], { actorId: userId });
  return { ok: true, left: true };
}

// ---------------------------------------------------------------------------------------------
// Images (station icons, track artwork). Public on the website, behind the Bearer secret here.

export async function readRadioIcon(stationId: string): Promise<Buffer | null> {
  const station = await getStation(stationId);
  return station?.iconAssetId ? readPageAsset(GLOBAL_ASSET_KEY, "radio", station.iconAssetId) : null;
}

export async function readRadioArtwork(stationId: string, trackId: string): Promise<Buffer | null> {
  const track = (await listTracks(stationId)).find((t) => t.id === trackId);
  return track?.artworkAssetId ? readPageAsset(GLOBAL_ASSET_KEY, "radio", track.artworkAssetId) : null;
}

// ---------------------------------------------------------------------------------------------
// Platform (operator) endpoints. Callers check isDashboardSuperuser first.

const HEX = /^#[0-9a-fA-F]{6}$/;

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.trim().slice(0, max) : undefined;
}

/** Validates the editable station fields. Returns an error string or the clean input. */
export function parseStationInput(body: Record<string, unknown>, requireName: boolean): StationInput | string {
  const input: StationInput = {};
  const name = text(body.name, RADIO_LIMITS.name);
  if (name !== undefined) {
    if (!name) return "A station needs a name.";
    input.name = name;
  } else if (requireName) {
    return "A station needs a name.";
  }
  const description = text(body.description, RADIO_LIMITS.description);
  if (description !== undefined) input.description = description;
  if (body.genre !== undefined) input.genre = body.genre === null ? null : text(body.genre, RADIO_LIMITS.genre) || null;
  if (body.accentColor !== undefined) {
    if (body.accentColor !== null && (typeof body.accentColor !== "string" || !HEX.test(body.accentColor))) {
      return "accentColor must be a #RRGGBB colour or null.";
    }
    input.accentColor = body.accentColor as string | null;
  }
  if (body.shuffle !== undefined) {
    if (typeof body.shuffle !== "boolean") return "shuffle must be true or false.";
    input.shuffle = body.shuffle;
  }
  if (body.visibility !== undefined) {
    if (!(RADIO_VISIBILITIES as readonly unknown[]).includes(body.visibility)) return "visibility must be draft or live.";
    input.visibility = body.visibility as StationInput["visibility"];
  }
  if (body.sortOrder !== undefined) {
    if (!Number.isInteger(body.sortOrder)) return "sortOrder must be a whole number.";
    input.sortOrder = body.sortOrder as number;
  }
  return input;
}

export async function listPlatformRadios(): Promise<{ stations: RadioStationAdmin[]; storage: { usedBytes: number; limitBytes: number } }> {
  const counts = listenerCounts();
  const stations = await Promise.all((await listStations()).map((s) => toAdmin(s, counts)));
  return { stations, storage: { usedBytes: await totalStorageBytes(), limitBytes: radioStorageLimitBytes() } };
}

export async function createPlatformRadio(body: Record<string, unknown>, actorId: string): Promise<Result<{ station: RadioStationAdmin }>> {
  const input = parseStationInput(body, true);
  if (typeof input === "string") return { ok: false, status: 400, error: input };
  try {
    const station = await createStation({ ...input, name: input.name! }, actorId);
    await refreshStationClock(station.id);
    return { ok: true, station: await toAdmin(station) };
  } catch (error) {
    return { ok: false, status: 400, error: error instanceof Error ? error.message : "Couldn't create the station." };
  }
}

export async function updatePlatformRadio(stationId: string, body: Record<string, unknown>): Promise<Result<{ station: RadioStationAdmin }>> {
  const input = parseStationInput(body, false);
  if (typeof input === "string") return { ok: false, status: 400, error: input };
  const before = await getStation(stationId);
  if (!before) return { ok: false, status: 404, error: "Station not found." };
  const station = await updateStation(stationId, input);
  if (!station) return { ok: false, status: 404, error: "Station not found." };
  await refreshStationClock(stationId, { reseed: input.shuffle !== undefined && input.shuffle !== before.shuffle });
  // Taken off air: anyone tuned in moves on when the current song ends (see controller.ts).
  return { ok: true, station: await toAdmin(station) };
}

export async function deletePlatformRadio(stationId: string): Promise<Result<object>> {
  const deleted = await deleteStation(stationId);
  if (!deleted) return { ok: false, status: 404, error: "Station not found." };
  forgetStationClock(stationId);
  await refreshKeptRadioAssets();
  return { ok: true };
}

export async function setPlatformRadioIcon(stationId: string, imageBase64: unknown): Promise<Result<{ station: RadioStationAdmin }>> {
  if (!(await getStation(stationId))) return { ok: false, status: 404, error: "Station not found." };
  let iconAssetId: string | null = null;
  if (imageBase64 !== null) {
    if (typeof imageBase64 !== "string" || !imageBase64) return { ok: false, status: 400, error: "imageBase64 must be an image or null." };
    try {
      iconAssetId = (await savePageAsset(GLOBAL_ASSET_KEY, "radio", decodeBase64Upload(imageBase64))).assetId;
    } catch (error) {
      return { ok: false, status: 400, error: error instanceof Error ? error.message : "Couldn't read that image." };
    }
  }
  const station = await updateStation(stationId, { iconAssetId });
  await refreshKeptRadioAssets();
  await refreshStationClock(stationId);
  return { ok: true, station: await toAdmin(station!) };
}

function uploadError(error: unknown): { ok: false; status: number; error: string } {
  if (error instanceof RadioUploadError) return { ok: false, status: error.status, error: error.message };
  return { ok: false, status: 500, error: "Upload failed." };
}

export async function startPlatformUpload(stationId: string, body: Record<string, unknown>, actorId: string): Promise<Result<{ uploadId: string; chunkBytes: number }>> {
  if (!(await getStation(stationId))) return { ok: false, status: 404, error: "Station not found." };
  const filename = typeof body.filename === "string" ? body.filename : "";
  const sizeBytes = Number(body.sizeBytes);
  try {
    return { ok: true, ...(await startUpload(stationId, filename, sizeBytes, actorId)) };
  } catch (error) {
    return uploadError(error);
  }
}

export async function appendPlatformChunk(stationId: string, uploadId: string, body: Record<string, unknown>): Promise<Result<{ receivedBytes: number }>> {
  if (!Number.isInteger(body.index) || typeof body.dataBase64 !== "string") {
    return { ok: false, status: 400, error: "index and dataBase64 are required." };
  }
  try {
    return { ok: true, ...(await appendChunk(stationId, uploadId, body.index as number, body.dataBase64)) };
  } catch (error) {
    return uploadError(error);
  }
}

export async function completePlatformUpload(stationId: string, uploadId: string, actorId: string): Promise<Result<{ track: RadioTrackAdmin; duplicate: boolean }>> {
  try {
    const { track, duplicate } = await completeUpload(stationId, uploadId, actorId);
    await refreshKeptRadioAssets();
    if (!duplicate) await refreshStationClock(stationId);
    return { ok: true, track: toTrackAdmin(track), duplicate };
  } catch (error) {
    return uploadError(error);
  }
}

export async function abortPlatformUpload(stationId: string, uploadId: string): Promise<Result<object>> {
  await abortUpload(stationId, uploadId);
  return { ok: true };
}

export async function editPlatformTracks(stationId: string, body: Record<string, unknown>): Promise<Result<{ station: RadioStationAdmin }>> {
  const station = await getStation(stationId);
  if (!station) return { ok: false, status: 404, error: "Station not found." };
  const tracks = await listTracks(stationId);
  const ids = new Set(tracks.map((t) => t.id));
  if (Array.isArray(body.edits)) {
    for (const raw of body.edits as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const edit = raw as { id?: unknown; title?: unknown; artist?: unknown };
      if (typeof edit.id !== "string" || !ids.has(edit.id)) continue;
      const title = text(edit.title, RADIO_LIMITS.title);
      if (title === "") return { ok: false, status: 400, error: "A track needs a title." };
      const artist = edit.artist === null ? null : text(edit.artist, RADIO_LIMITS.artist);
      await updateTrackMeta(stationId, edit.id, { title, artist: artist === "" ? null : artist });
    }
  }
  if (body.order !== undefined) {
    if (!Array.isArray(body.order) || !body.order.every((id) => typeof id === "string")) {
      return { ok: false, status: 400, error: "order must list every track id." };
    }
    if (!(await reorderTracks(stationId, body.order as string[]))) return { ok: false, status: 400, error: "order must list every track id once." };
  }
  await refreshStationClock(stationId);
  return { ok: true, station: await toAdmin((await getStation(stationId))!) };
}

export async function deletePlatformTrack(stationId: string, trackId: string): Promise<Result<{ station: RadioStationAdmin }>> {
  const station = await getStation(stationId);
  if (!station) return { ok: false, status: 404, error: "Station not found." };
  moveOffTrack(stationId, trackId);
  if (!(await removeTrack(stationId, trackId))) return { ok: false, status: 404, error: "Track not found." };
  await refreshKeptRadioAssets();
  await refreshStationClock(stationId);
  return { ok: true, station: await toAdmin(station) };
}

export async function skipPlatformRadio(stationId: string): Promise<Result<{ station: RadioStationAdmin }>> {
  const station = await getStation(stationId);
  if (!station) return { ok: false, status: 404, error: "Station not found." };
  if (!skipStation(stationId)) return { ok: false, status: 409, error: "This station has no tracks yet." };
  return { ok: true, station: await toAdmin(station) };
}

/** Lets the bridge 404 cleanly on a bad id before touching anything else. */
export async function radioStationExists(stationId: string): Promise<boolean> {
  return Boolean(await getStation(stationId));
}
