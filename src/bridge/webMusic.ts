import type { Client, Guild, GuildMember } from "discord.js";
import type { Track } from "lavalink-client";
import { getExistingPlayer, isLavalinkConfigured } from "../plugins/music/functions/manager.js";
import { destroyPlayer, getOrConnectPlayer } from "../plugins/music/functions/player.js";
import { saveSessionNow } from "../plugins/music/functions/sessionPersistence.js";
import { applyFilterPreset } from "../plugins/music/functions/filters.js";
import { clearQueue, move, removeAt } from "../plugins/music/functions/queueOps.js";
import { getLogger } from "../core/logger.js";
import { configManager } from "../config/manager.js";
import { getPluginSettings, hasAdminBypass, resolveEffectivePluginConfig } from "../core/permissionRoles.js";
import { pluginEnabled } from "../core/pluginCommand.js";
import type { GuildConfig } from "../config/schemas/guild.js";
import {
  MUSIC_FILTER_PRESETS,
  MUSIC_LOOP_MODES,
  zMusicConfig,
  type MusicConfig,
  type MusicFilterPreset,
  type MusicLoopMode,
} from "../config/schemas/music.js";
import { canBypassVoteSkip, canControlPlayback, isDj } from "../plugins/music/functions/permissions.js";
import { clearVotes, registerVote, requiredVotes } from "../plugins/music/functions/voteSkip.js";
import { logMusic } from "../plugins/music/functions/musicLog.js";
import { formatDuration } from "../plugins/music/functions/formatting.js";

const log = getLogger("bridge");

export type WebMusicRequester = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /** DJ role holder, or an admin/owner who bypasses the DJ system entirely — one badge for
   *  "this person has elevated music privileges", the same distinction /skip's vote-bypass uses. */
  isDJ: boolean;
};

export type WebMusicTrack = {
  encoded: string;
  title: string;
  author: string | null;
  uri: string | null;
  artworkUrl: string | null;
  durationMs: number;
  sourceName: string;
  requestedBy: WebMusicRequester | null;
};

export type WebVoiceChannel = { id: string; name: string };

export type WebMusicState = {
  active: boolean;
  current: (WebMusicTrack & { positionMs: number; paused: boolean }) | null;
  queue: WebMusicTrack[];
  volume: number;
  loopMode: string;
  /** Which /filter presets this server allows — the web player only offers these, same as
   *  /filter's own `auth.config.allowed_filters` check. */
  allowedFilters: string[];
  /** The viewer's own current voice channel, if any — lets the "no session yet" empty state offer
   *  a one-click "Start a session in #channel" instead of just telling them to use /play. */
  viewerVoiceChannel: WebVoiceChannel | null;
};

function requesterIdOf(track: Track): string | null {
  return (track.requester as { id?: string } | undefined)?.id ?? null;
}

function toWebTrack(track: Track, requesters?: Map<string, WebMusicRequester>): WebMusicTrack {
  const requesterId = requesterIdOf(track);
  return {
    encoded: track.encoded ?? "",
    title: track.info.title,
    author: track.info.author || null,
    uri: track.info.uri || null,
    artworkUrl: track.info.artworkUrl,
    durationMs: track.info.duration,
    sourceName: track.info.sourceName,
    requestedBy: (requesterId && requesters?.get(requesterId)) || null,
  };
}

/** Live-resolves a batch of Discord user ids to display-ready info, the same
 *  member-fetch-then-user-fetch-then-null pattern used across the other bridge modules
 *  (e.g. webLogs.ts, webModeration.ts) — never throws, just omits ids it can't resolve.
 *  `musicConfig`/`guildConfig` are only used to flag each requester's DJ/admin status, the same
 *  `isDj`/`hasAdminBypass` checks /skip uses, not anything member-specific to the viewer. */
async function resolveRequesters(
  guild: Guild,
  ids: Iterable<string>,
  musicConfig: MusicConfig,
  guildConfig: GuildConfig,
): Promise<Map<string, WebMusicRequester>> {
  const map = new Map<string, WebMusicRequester>();
  await Promise.all(
    Array.from(new Set(ids)).map(async (id) => {
      const member = await guild.members.fetch(id).catch(() => null);
      const user = member?.user ?? (await guild.client.users.fetch(id).catch(() => null));
      if (!user) return;
      map.set(id, {
        id,
        username: user.username,
        displayName: member?.displayName ?? user.globalName ?? user.username,
        avatarUrl: (member ?? user).displayAvatarURL({ size: 128 }),
        isDJ: member ? isDj(member, musicConfig) || hasAdminBypass(member, guildConfig) : false,
      });
    }),
  );
  return map;
}

/** Reconstructs a playable Track from what the web client already has (its own earlier search
 *  result or the current queue payload) - the encoded string alone isn't enough for queue.add. */
function fromWebTrack(input: WebMusicTrack, requesterId: string): Track {
  return {
    encoded: input.encoded,
    info: {
      identifier: input.encoded,
      title: input.title,
      author: input.author ?? "",
      duration: input.durationMs,
      artworkUrl: input.artworkUrl,
      uri: input.uri ?? "",
      sourceName: (input.sourceName || "http") as Track["info"]["sourceName"],
      isSeekable: true,
      isStream: false,
      isrc: null,
    },
    pluginInfo: {},
    requester: { id: requesterId },
  };
}

async function resolveViewerVoiceChannel(guild: Guild, userId: string): Promise<WebVoiceChannel | null> {
  const member = await guild.members.fetch(userId).catch(() => null);
  const channel = member?.voice.channel;
  return channel ? { id: channel.id, name: channel.name } : null;
}

export async function getWebMusicState(guild: Guild, userId: string): Promise<WebMusicState> {
  const player = getExistingPlayer(guild.id);
  const viewerVoiceChannel = await resolveViewerVoiceChannel(guild, userId);
  if (!player) {
    return {
      active: false,
      current: null,
      queue: [],
      volume: 80,
      loopMode: "off",
      allowedFilters: [],
      viewerVoiceChannel,
    };
  }
  const current = player.queue.current;
  const resolvedQueue = player.queue.tracks.filter((t): t is Track => !("resolve" in t));

  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  // Settings-only resolution (no member in context here) — fine for dj_roles/dj_mode, which
  // aren't permission grants themselves, just who the DJ role list names.
  const musicConfig = zMusicConfig.parse(getPluginSettings(guildConfig, "music"));

  const ids = new Set<string>();
  if (current) {
    const id = requesterIdOf(current);
    if (id) ids.add(id);
  }
  for (const t of resolvedQueue) {
    const id = requesterIdOf(t);
    if (id) ids.add(id);
  }
  const requesters = await resolveRequesters(guild, ids, musicConfig, guildConfig);

  return {
    active: true,
    current: current
      ? { ...toWebTrack(current, requesters), positionMs: Math.round(player.position), paused: player.paused }
      : null,
    queue: resolvedQueue.map((t) => toWebTrack(t, requesters)),
    volume: player.volume,
    loopMode: player.repeatMode,
    allowedFilters: musicConfig.allowed_filters,
    viewerVoiceChannel,
  };
}

export type WebActionResult = { ok: true } | { ok: false; status: number; error: string };

type MusicAuth =
  | { ok: true; member: GuildMember; config: MusicConfig; guildConfig: GuildConfig }
  | { ok: false; status: number; error: string };

/** Same gate every /music slash command goes through (requireMusicPermission ->
 *  requirePluginPermission), just without an Interaction to reply through — resolves the caller's
 *  member and their effective per-member MusicConfig (can_* flags already OR'd across their
 *  Dreamliner Roles and admin bypass, exactly like the real commands see). */
async function loadMusicAuth(guild: Guild, userId: string): Promise<MusicAuth> {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return { ok: false, status: 403, error: "You need to be a member of this server." };

  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  if (!pluginEnabled(guildConfig, "music")) {
    return { ok: false, status: 403, error: "Music is disabled on this server." };
  }

  const raw = await resolveEffectivePluginConfig(guild.id, "music", member, guildConfig);
  return { ok: true, member, config: zMusicConfig.parse(raw), guildConfig };
}

/** The one action here that doesn't require an existing player — mirrors /join, so someone can
 *  put the bot in their voice channel from the "no session" empty state before anything's queued. */
export async function joinWebVoiceSession(guild: Guild, userId: string): Promise<WebActionResult> {
  const auth = await loadMusicAuth(guild, userId);
  if (!auth.ok) return auth;
  if (!auth.config.can_play) {
    return { ok: false, status: 403, error: "You don't have permission to start a session." };
  }
  if (!isLavalinkConfigured()) {
    return { ok: false, status: 503, error: "Music isn't configured on this bot yet." };
  }

  const voiceChannelId = auth.member.voice.channelId;
  if (!voiceChannelId) {
    return { ok: false, status: 400, error: "Join a voice channel first." };
  }

  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  const musicConfig = zMusicConfig.parse(getPluginSettings(guildConfig, "music"));
  const textChannelId = musicConfig.announce_channel_id || guild.systemChannelId || guild.id;

  const claim = await getOrConnectPlayer(guild.id, voiceChannelId, textChannelId);
  if (!claim.ok) {
    const error =
      claim.reason === "blocked_by_other"
        ? "Another feature is already using voice in this server."
        : "Couldn't connect to that voice channel.";
    return { ok: false, status: 409, error };
  }
  void saveSessionNow(claim.player).catch(() => {});
  void logMusic(guild.client, guildConfig, guild.id, "music_session", "Music - Joined Voice", [
    `By: <@${userId}>`,
    "Source: Web player",
    `Channel: <#${voiceChannelId}>`,
  ], { actorId: userId, channelId: voiceChannelId });
  return { ok: true };
}

export async function searchWebMusic(
  guild: Guild,
  userId: string,
  query: string,
): Promise<{ tracks: WebMusicTrack[] } | { error: string; status: number }> {
  const player = getExistingPlayer(guild.id);
  if (!player) return { error: "No active music session in this server right now.", status: 409 };

  const auth = await loadMusicAuth(guild, userId);
  if (!auth.ok) return { error: auth.error, status: auth.status };
  if (!auth.config.can_play) return { error: "You don't have permission to search for tracks.", status: 403 };

  const trimmed = query.trim();
  if (!trimmed) return { tracks: [] };
  try {
    const result = await player.search({ query: trimmed }, { id: "web" });
    if (result.loadType === "error" || result.loadType === "empty") return { tracks: [] };
    const resolved = result.tracks.filter((t): t is Track => !("resolve" in t));
    return { tracks: resolved.slice(0, 10).map((t) => toWebTrack(t)) };
  } catch (error) {
    log.error(`Web music search failed for guild ${guild.id}:`, error);
    return { error: "Search failed.", status: 502 };
  }
}

export async function queueWebTrack(guild: Guild, userId: string, track: WebMusicTrack): Promise<WebActionResult> {
  const player = getExistingPlayer(guild.id);
  if (!player) return { ok: false, status: 409, error: "No active music session in this server right now." };

  const auth = await loadMusicAuth(guild, userId);
  if (!auth.ok) return auth;
  const { config, guildConfig } = auth;

  if (!config.can_play) {
    return { ok: false, status: 403, error: "You don't have permission to queue tracks." };
  }
  if (config.max_track_duration_minutes > 0 && track.durationMs > config.max_track_duration_minutes * 60_000) {
    return {
      ok: false,
      status: 400,
      error: `Tracks longer than ${config.max_track_duration_minutes} minutes aren't allowed here.`,
    };
  }
  const queueSize = player.queue.tracks.length + (player.queue.current ? 1 : 0);
  if (queueSize >= config.max_queue_size) {
    return { ok: false, status: 400, error: "The queue is full." };
  }

  try {
    const wasPlaying = player.playing || Boolean(player.queue.current);
    const size = await player.queue.add(fromWebTrack(track, userId));
    if (!player.playing && !player.queue.current) await player.play();
    void saveSessionNow(player).catch(() => {});
    void logMusic(
      guild.client,
      guildConfig,
      guild.id,
      "music_play",
      wasPlaying ? "Music - Track Queued" : "Music - Track Started",
      [
        `By: <@${userId}>`,
        "Source: Web player",
        `Track: **${track.title}**${track.author ? ` - ${track.author}` : ""} (\`${formatDuration(track.durationMs)}\`)`,
        wasPlaying ? `Position: #${Number(size) || 0} in queue` : "Position: now playing",
      ],
      { actorId: userId, avatarUrl: track.artworkUrl },
    );
    return { ok: true };
  } catch (error) {
    log.error(`Web queue add failed for guild ${guild.id}:`, error);
    return { ok: false, status: 502, error: "Couldn't queue that track." };
  }
}

export type WebSkipResult =
  | { ok: true; skipped: true }
  | { ok: true; skipped: false; have: number; need: number; alreadyVoted: boolean }
  | { ok: false; status: number; error: string };

/** Mirrors /skip's own bypass-vs-vote branching exactly (playback.ts) — DJs, force-skippers, and
 *  a track's own requester skip instantly; everyone else's skip becomes a vote against the
 *  channel's non-bot headcount, using the same shared vote-skip state /skip uses. */
export async function webSkip(guild: Guild, userId: string): Promise<WebSkipResult> {
  const player = getExistingPlayer(guild.id);
  if (!player) return { ok: false, status: 409, error: "No active music session in this server right now." };

  const auth = await loadMusicAuth(guild, userId);
  if (!auth.ok) return auth;
  const { member, config, guildConfig } = auth;

  if (!config.can_skip) {
    return { ok: false, status: 403, error: "You don't have permission to skip." };
  }
  if (member.voice.channelId !== player.voiceChannelId) {
    return { ok: false, status: 403, error: "You need to be in the voice channel to skip." };
  }

  const current = player.queue.current;
  const requesterId = current ? requesterIdOf(current) : null;
  const bypass = canBypassVoteSkip(member, config, config.can_force_skip) || requesterId === userId;
  const trackLine = current ? `Track: **${current.info.title}**${current.info.author ? ` - ${current.info.author}` : ""}` : "Track: (none)";

  if (bypass) {
    clearVotes(guild.id);
    await player.skip();
    void logMusic(guild.client, guildConfig, guild.id, "music_skip", "Music - Track Skipped", [
      `By: <@${userId}>`,
      "Source: Web player",
      trackLine,
      "Method: Direct skip",
    ], { actorId: userId });
    return { ok: true, skipped: true };
  }

  const channel = member.voice.channel;
  const nonBotCount = channel ? channel.members.filter((m) => !m.user.bot).size : 1;
  const need = requiredVotes(nonBotCount, config.vote_skip_threshold_percent);
  const result = registerVote(guild.id, current?.encoded, userId, need, config.vote_skip_timeout_seconds * 1000);

  if (result.status === "skipped") {
    await player.skip();
    void logMusic(guild.client, guildConfig, guild.id, "music_skip", "Music - Track Skipped", [
      `By: <@${userId}>`,
      "Source: Web player",
      trackLine,
      `Method: Vote passed (${need} needed)`,
    ], { actorId: userId });
    return { ok: true, skipped: true };
  }
  return { ok: true, skipped: false, have: result.have, need: result.need, alreadyVoted: result.status === "already_voted" };
}

type PlaybackAuth =
  | { ok: true; member: GuildMember; config: MusicConfig; guildConfig: GuildConfig }
  | { ok: false; status: number; error: string };

/** loadMusicAuth() plus the same DJ-mode-aware canControlPlayback gate every direct-control
 *  command uses (pause/resume/stop/volume/seek/filter/loop/shuffle/queue management) — `hasFlag`
 *  picks which can_* permission this particular action needs. */
async function requirePlaybackControl(
  guild: Guild,
  userId: string,
  hasFlag: (config: MusicConfig) => boolean,
): Promise<PlaybackAuth> {
  const auth = await loadMusicAuth(guild, userId);
  if (!auth.ok) return auth;
  const { member, config, guildConfig } = auth;
  if (!canControlPlayback(member, config, hasFlag(config))) {
    const error = config.dj_mode ? "Only DJs can do that while DJ mode is on." : "You don't have permission to do that.";
    return { ok: false, status: 403, error };
  }
  return { ok: true, member, config, guildConfig };
}

export async function webSetPaused(guild: Guild, userId: string, paused: boolean): Promise<WebActionResult> {
  const player = getExistingPlayer(guild.id);
  if (!player) return { ok: false, status: 409, error: "No active music session in this server right now." };

  const auth = await requirePlaybackControl(guild, userId, (c) => c.can_control_playback);
  if (!auth.ok) return auth;

  if (paused) await player.pause();
  else await player.resume();
  void saveSessionNow(player).catch(() => {});
  void logMusic(guild.client, auth.guildConfig, guild.id, "music_playback", paused ? "Music - Paused" : "Music - Resumed", [
    `By: <@${userId}>`,
    "Source: Web player",
  ], { actorId: userId });
  return { ok: true };
}

export async function stopWebPlayer(guild: Guild, userId: string): Promise<WebActionResult> {
  const player = getExistingPlayer(guild.id);
  if (!player) return { ok: false, status: 409, error: "No active music session in this server right now." };

  const auth = await requirePlaybackControl(guild, userId, (c) => c.can_control_playback);
  if (!auth.ok) return auth;

  clearVotes(guild.id);
  await destroyPlayer(guild.id, "stopped from the web player");
  void logMusic(guild.client, auth.guildConfig, guild.id, "music_stop", "Music - Playback Stopped", [
    `By: <@${userId}>`,
    "Source: Web player",
  ], { actorId: userId });
  return { ok: true };
}

export async function setWebVolume(guild: Guild, userId: string, percent: number): Promise<WebActionResult> {
  const player = getExistingPlayer(guild.id);
  if (!player) return { ok: false, status: 409, error: "No active music session in this server right now." };
  if (!Number.isInteger(percent) || percent < 0 || percent > 150) {
    return { ok: false, status: 400, error: "Volume must be between 0 and 150." };
  }

  const auth = await requirePlaybackControl(guild, userId, (c) => c.can_control_playback);
  if (!auth.ok) return auth;

  await player.setVolume(percent);
  void saveSessionNow(player).catch(() => {});
  void logMusic(guild.client, auth.guildConfig, guild.id, "music_playback", "Music - Volume Changed", [
    `By: <@${userId}>`,
    "Source: Web player",
    `Volume set to **${percent}%**`,
  ], { actorId: userId });
  return { ok: true };
}

export async function setWebFilter(guild: Guild, userId: string, preset: string): Promise<WebActionResult> {
  const player = getExistingPlayer(guild.id);
  if (!player) return { ok: false, status: 409, error: "No active music session in this server right now." };
  if (!(MUSIC_FILTER_PRESETS as readonly string[]).includes(preset)) {
    return { ok: false, status: 400, error: "That filter preset doesn't exist." };
  }

  const auth = await requirePlaybackControl(guild, userId, (c) => c.can_control_playback);
  if (!auth.ok) return auth;
  if (!auth.config.allowed_filters.includes(preset as MusicFilterPreset)) {
    return { ok: false, status: 403, error: "That filter preset is disabled on this server." };
  }

  await applyFilterPreset(player, preset as MusicFilterPreset);
  void logMusic(guild.client, auth.guildConfig, guild.id, "music_filter", "Music - Filter Changed", [
    `By: <@${userId}>`,
    "Source: Web player",
    `Filter set to **${preset}**`,
  ], { actorId: userId });
  return { ok: true };
}

export async function setWebLoopMode(guild: Guild, userId: string, mode: string): Promise<WebActionResult> {
  const player = getExistingPlayer(guild.id);
  if (!player) return { ok: false, status: 409, error: "No active music session in this server right now." };
  if (!(MUSIC_LOOP_MODES as readonly string[]).includes(mode)) {
    return { ok: false, status: 400, error: "That's not a valid loop mode." };
  }

  const auth = await requirePlaybackControl(guild, userId, (c) => c.can_manage_queue);
  if (!auth.ok) return auth;

  await player.setRepeatMode(mode as MusicLoopMode);
  void saveSessionNow(player).catch(() => {});
  void logMusic(guild.client, auth.guildConfig, guild.id, "music_queue", "Music - Loop Mode Changed", [
    `By: <@${userId}>`,
    "Source: Web player",
    `Loop mode set to **${mode}**`,
  ], { actorId: userId });
  return { ok: true };
}

export async function shuffleWebQueue(guild: Guild, userId: string): Promise<WebActionResult> {
  const player = getExistingPlayer(guild.id);
  if (!player) return { ok: false, status: 409, error: "No active music session in this server right now." };

  const auth = await requirePlaybackControl(guild, userId, (c) => c.can_manage_queue);
  if (!auth.ok) return auth;

  await player.queue.shuffle();
  void saveSessionNow(player).catch(() => {});
  void logMusic(guild.client, auth.guildConfig, guild.id, "music_queue", "Music - Queue Shuffled", [
    `By: <@${userId}>`,
    "Source: Web player",
  ], { actorId: userId });
  return { ok: true };
}

export async function clearWebQueue(guild: Guild, userId: string): Promise<WebActionResult> {
  const player = getExistingPlayer(guild.id);
  if (!player) return { ok: false, status: 409, error: "No active music session in this server right now." };

  const auth = await requirePlaybackControl(guild, userId, (c) => c.can_manage_queue);
  if (!auth.ok) return auth;

  const count = await clearQueue(player);
  void saveSessionNow(player).catch(() => {});
  void logMusic(guild.client, auth.guildConfig, guild.id, "music_queue", "Music - Queue Cleared", [
    `By: <@${userId}>`,
    "Source: Web player",
    `Cleared **${count}** track${count === 1 ? "" : "s"}`,
  ], { actorId: userId });
  return { ok: true };
}

export async function removeWebQueueTrack(guild: Guild, userId: string, position: number): Promise<WebActionResult> {
  const player = getExistingPlayer(guild.id);
  if (!player) return { ok: false, status: 409, error: "No active music session in this server right now." };

  const auth = await requirePlaybackControl(guild, userId, (c) => c.can_manage_queue);
  if (!auth.ok) return auth;

  const result = await removeAt(player, position);
  if (!result.ok) return { ok: false, status: 400, error: "No track at that position." };
  void saveSessionNow(player).catch(() => {});
  void logMusic(guild.client, auth.guildConfig, guild.id, "music_queue", "Music - Queue Track Removed", [
    `By: <@${userId}>`,
    "Source: Web player",
    `Removed **${result.title}** (position #${position})`,
  ], { actorId: userId });
  return { ok: true };
}

export async function moveWebQueueTrack(guild: Guild, userId: string, from: number, to: number): Promise<WebActionResult> {
  const player = getExistingPlayer(guild.id);
  if (!player) return { ok: false, status: 409, error: "No active music session in this server right now." };

  const auth = await requirePlaybackControl(guild, userId, (c) => c.can_manage_queue);
  if (!auth.ok) return auth;

  const result = await move(player, from, to);
  if (!result.ok) return { ok: false, status: 400, error: "Invalid position." };
  void saveSessionNow(player).catch(() => {});
  void logMusic(guild.client, auth.guildConfig, guild.id, "music_queue", "Music - Queue Track Moved", [
    `By: <@${userId}>`,
    "Source: Web player",
    `Moved track from #${from} to #${to}`,
  ], { actorId: userId });
  return { ok: true };
}

export type WebActiveUserMusicSession =
  | { active: false }
  | {
      active: true;
      guildId: string;
      guildName: string;
      track: { title: string; author: string | null; artworkUrl: string | null };
      paused: boolean;
    };

/** For the navbar "now playing" pill — not guild-scoped, since the user could be listening in any
 *  server the bot shares with them. Only checks guilds that already have an active player (a
 *  cheap, local, synchronous lookup), so this stays fast even on a bot in many guilds — it never
 *  iterates every guild's member list, just fetches the one member being asked about, and only in
 *  guilds where something is actually playing. */
export async function getActiveUserMusicSession(client: Client, userId: string): Promise<WebActiveUserMusicSession> {
  for (const guild of client.guilds.cache.values()) {
    const player = getExistingPlayer(guild.id);
    const current = player?.queue.current;
    if (!player || !current) continue;

    const member = await guild.members.fetch(userId).catch(() => null);
    if (member?.voice.channelId !== player.voiceChannelId) continue;

    return {
      active: true,
      guildId: guild.id,
      guildName: guild.name,
      track: {
        title: current.info.title,
        author: current.info.author || null,
        artworkUrl: current.info.artworkUrl,
      },
      paused: player.paused,
    };
  }
  return { active: false };
}

export type WebPlaylistQueueTrack = {
  encoded: string | null;
  title: string;
  author: string | null;
  uri: string | null;
  artworkUrl: string | null;
  durationMs: number;
};

export type WebQueuePlaylistResult =
  | { ok: true; queued: number; skipped: number }
  | { ok: false; status: number; error: string };

/** Queues a saved playlist's tracks into this guild's already-active session — mirrors /playlist
 *  load's own permission/limit checks, minus its "start a session if none exists" step (the web
 *  player's own "Start a session" button already covers that, and doing it here too would need a
 *  voice channel to join, which this action has no way to ask for). */
export async function queueWebPlaylist(
  guild: Guild,
  userId: string,
  tracks: WebPlaylistQueueTrack[],
): Promise<WebQueuePlaylistResult> {
  const player = getExistingPlayer(guild.id);
  if (!player) {
    return { ok: false, status: 409, error: "Start a session in your voice channel first." };
  }

  const auth = await loadMusicAuth(guild, userId);
  if (!auth.ok) return auth;
  if (!auth.config.can_play) {
    return { ok: false, status: 403, error: "You don't have permission to queue tracks." };
  }

  let queued = 0;
  let skipped = 0;
  for (const t of tracks) {
    if (!t.encoded) {
      skipped++;
      continue;
    }
    const queueSize = player.queue.tracks.length + (player.queue.current ? 1 : 0);
    if (queueSize >= auth.config.max_queue_size) break;
    if (auth.config.max_track_duration_minutes > 0 && t.durationMs > auth.config.max_track_duration_minutes * 60_000) {
      skipped++;
      continue;
    }
    try {
      await player.queue.add(
        fromWebTrack(
          { encoded: t.encoded, title: t.title, author: t.author, uri: t.uri, artworkUrl: t.artworkUrl, durationMs: t.durationMs, sourceName: "http", requestedBy: null },
          userId,
        ),
      );
      queued++;
    } catch {
      skipped++;
    }
  }

  if (queued === 0) {
    return { ok: false, status: 400, error: "None of those tracks could be queued." };
  }
  if (!player.playing && !player.queue.current) await player.play();
  void saveSessionNow(player).catch(() => {});
  void logMusic(guild.client, auth.guildConfig, guild.id, "music_play", "Music - Playlist Queued", [
    `By: <@${userId}>`,
    "Source: Web player",
    `Queued ${queued} track${queued === 1 ? "" : "s"}${skipped ? `, ${skipped} skipped` : ""}`,
  ], { actorId: userId });
  return { ok: true, queued, skipped };
}
