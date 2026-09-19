import type { Client } from "discord.js";
import type { Player, Track, UnresolvedTrack } from "lavalink-client";
import { getLogger } from "../../../core/logger.js";
import { configManager } from "../../../config/manager.js";
import { zMusicConfig } from "../../../config/schemas/music.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { logMusic } from "./musicLog.js";

const log = getLogger("music");

/** Keep at least this many tracks queued up behind the current one whenever autoplay is on, so
 *  a skip (or several in a row) never runs the player dry. */
const MIN_AUTOPLAY_QUEUE_LENGTH = 5;

/** How often a fill branches off a random earlier track from this session instead of always
 *  chaining off the very last thing queued - without this, a run quietly settles into one
 *  artist's catalog (each pick's author/title just re-finds more of the same artist). */
const RESEED_CHANCE = 0.4;

/** The minimal shape autoplay actually needs from a "what to find something similar to" seed -
 *  a real Track satisfies this, but so does a lightweight reconstruction from session history
 *  (see pickSeed), which doesn't need to carry a full, real Track around. */
type AutoplaySeed = {
  info: { identifier: string; title: string; author: string; sourceName: string };
  requester?: Track["requester"];
};

/** A Lavalink search response (or a queue slot) is always fully resolved in practice - this just
 *  satisfies lavalink-client's Track | UnresolvedTrack typing without pretending an unresolved
 *  stub (no real identifier yet) is a usable autoplay seed/candidate. */
function isResolvedTrack(track: Track | UnresolvedTrack | null | undefined): track is Track {
  return Boolean(track) && typeof track!.info.identifier === "string" && track!.info.identifier.length > 0;
}

function asResolvedTracks(tracks: (Track | UnresolvedTrack)[]): Track[] {
  return tracks.filter(isResolvedTrack);
}

/** Normalizes title/author into a "same song" fingerprint, so a lyric-video reupload or a
 *  "Topic" channel's auto-generated copy of a song already played doesn't slip through as a
 *  fresh pick just because it has a different video id. Strips bracketed noise like "(Official
 *  Video)" / "[Lyrics]" that would otherwise make two copies of the same song look different. */
function songKey(info: { title: string; author?: string | null }): string {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[([][^)\]]*[)\]]/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return `${normalize(info.author ?? "")}::${normalize(info.title)}`;
}

type SeenEntry = { identifier: string; songKey: string; title: string; author: string; sourceName: string };

/** Every track autoplay has already added or seen play in this guild's session - unbounded up to
 *  a generous cap for the session's lifetime (not persisted), so a long-running 24/7-style
 *  session doesn't loop back through the same handful of "similar" tracks. Cleared on player
 *  destroy (see events.ts). Also doubles as the pool ensureAutoplayQueueDepth occasionally
 *  branches a fresh seed from, to avoid settling into one artist. */
const HISTORY_LIMIT = 40;
const sessionHistory = new Map<string, SeenEntry[]>();

/** Marks a track as "already had its turn" - called for every track that starts playing
 *  (events.ts's trackStart), not just autoplay's own picks, so a song the user manually queued
 *  and already heard doesn't come back around either. */
export function rememberAutoplaySeen(guildId: string, track: AutoplaySeed | null | undefined): void {
  if (!track?.info?.identifier) return;
  const list = sessionHistory.get(guildId) ?? [];
  list.push({
    identifier: track.info.identifier,
    songKey: songKey(track.info),
    title: track.info.title,
    author: track.info.author,
    sourceName: track.info.sourceName,
  });
  while (list.length > HISTORY_LIMIT) list.shift();
  sessionHistory.set(guildId, list);
}

export function clearAutoplayHistory(guildId: string): void {
  sessionHistory.delete(guildId);
}

/** Everything a fresh autoplay pick must avoid: identifiers AND normalized song-keys of every
 *  track already played/queued by autoplay this session, plus whatever's currently sitting in
 *  the queue (upcoming or now playing) - covers both autoplay's own history and anything the
 *  user queued themselves. */
function exclusions(player: Player): { ids: string[]; keys: string[] } {
  const history = sessionHistory.get(player.guildId) ?? [];
  const ids = new Set(history.map((h) => h.identifier));
  const keys = new Set(history.map((h) => h.songKey));
  for (const track of player.queue.tracks) {
    if (!isResolvedTrack(track)) continue;
    ids.add(track.info.identifier);
    keys.add(songKey(track.info));
  }
  if (isResolvedTrack(player.queue.current)) {
    ids.add(player.queue.current.info.identifier);
    keys.add(songKey(player.queue.current.info));
  }
  return { ids: [...ids], keys: [...keys] };
}

/** A random candidate that isn't excluded by id or by song-key - randomized (not just "first
 *  match") so repeated fills for a similar-shaped query don't keep landing on the same track,
 *  and pulled out as a pure function so it's unit-testable without a Lavalink node. */
export function pickAutoplayCandidate(candidates: Track[], excludedIds: string[], excludedKeys: string[] = []): Track | null {
  const idSet = new Set(excludedIds);
  const keySet = new Set(excludedKeys);
  const valid = candidates.filter(
    (track) => track.info.identifier && !idSet.has(track.info.identifier) && !keySet.has(songKey(track.info)),
  );
  if (valid.length === 0) return null;
  return valid[Math.floor(Math.random() * valid.length)]!;
}

/** Core "find something similar to seedTrack and queue it" step - queues at most one track.
 *  Never throws; returns whether it actually queued something. Does NOT check autoplay_enabled
 *  itself - callers already know they want a track queued by the time they call this. */
export async function queueAutoplayTrack(
  client: Client,
  player: Player,
  seedTrack: AutoplaySeed,
  guildConfig: GuildConfig,
): Promise<boolean> {
  try {
    const requester = seedTrack.requester ?? { id: client.user?.id ?? player.guildId };
    const { ids, keys } = exclusions(player);
    const excludedIds = [...ids, seedTrack.info.identifier];
    let candidates: Track[] = [];

    // YouTube's own auto-generated "Mix"/radio playlist for a video - the closest thing to a
    // real recommendation feed available on this node (no Spotify/LavaSrc-recommendations
    // source is configured here, see manager.ts's comment on the ytdlp source in use).
    if (seedTrack.info.sourceName === "youtube" && seedTrack.info.identifier) {
      const mixUrl = `https://www.youtube.com/watch?v=${seedTrack.info.identifier}&list=RD${seedTrack.info.identifier}`;
      const mix = await player.search({ query: mixUrl }, requester).catch(() => null);
      if (mix?.tracks?.length) candidates = asResolvedTracks(mix.tracks);
    }

    // Fallback for non-YouTube sources, or if the Mix playlist didn't resolve to anything (or
    // only resolved to tracks already excluded) - a plain search on the seed track's own
    // author/title still gets something in the spirit of "similar to what was just played"
    // rather than leaving the queue short.
    if (!pickAutoplayCandidate(candidates, excludedIds, keys)) {
      const query = [seedTrack.info.author, seedTrack.info.title].filter(Boolean).join(" ");
      if (query) {
        const result = await player.search({ query, source: "ytsearch" }, requester).catch(() => null);
        if (result?.tracks?.length) candidates = [...candidates, ...asResolvedTracks(result.tracks)];
      }
    }

    const pick = pickAutoplayCandidate(candidates, excludedIds, keys);
    if (!pick) {
      log.info(`Autoplay found no fresh candidate in guild ${player.guildId}.`);
      return false;
    }

    pick.requester = requester;
    rememberAutoplaySeen(player.guildId, pick);
    player.queue.add(pick);

    void logMusic(client, guildConfig, player.guildId, "music_session", "Music - Autoplay", [
      `Added: **${pick.info.title}**${pick.info.author ? ` - ${pick.info.author}` : ""}`,
      `Because of: **${seedTrack.info.title}**`,
    ]);
    return true;
  } catch (error) {
    log.error(`Autoplay failed in guild ${player.guildId}:`, error);
    return false;
  }
}

/** Picks what to search "similar to" for the next fill. Most of the time this chains off
 *  whatever's most recently lined up (current track, or the last thing already queued), but a
 *  chunk of the time it deliberately branches off a random earlier track from this session's
 *  history instead - otherwise every successive pick's author/title just re-finds more of the
 *  same artist and the whole queue quietly turns into one artist's discography. */
function pickSeed(player: Player, fallbackSeed?: AutoplaySeed): AutoplaySeed | undefined {
  const lastQueued = player.queue.tracks[player.queue.tracks.length - 1];
  const primary: AutoplaySeed | undefined =
    (isResolvedTrack(lastQueued) ? lastQueued : undefined) ?? player.queue.current ?? fallbackSeed;

  const history = sessionHistory.get(player.guildId) ?? [];
  if (history.length > 1 && Math.random() < RESEED_CHANCE) {
    const entry = history[Math.floor(Math.random() * history.length)];
    if (entry) return { info: entry };
  }

  return primary;
}

/** Tops the queue back up to MIN_AUTOPLAY_QUEUE_LENGTH. `fallbackSeed` covers the one moment
 *  there's nothing to chain off at all - the queue-empty hook, where the queue and `current` may
 *  already be cleared by the time this runs. Returns how many tracks it actually added. Bounded
 *  so a string of failed searches can't spin forever. */
export async function ensureAutoplayQueueDepth(
  client: Client,
  player: Player,
  guildConfig: GuildConfig,
  fallbackSeed?: AutoplaySeed,
): Promise<number> {
  let added = 0;
  let guard = 0;
  while (player.queue.tracks.length < MIN_AUTOPLAY_QUEUE_LENGTH && guard < MIN_AUTOPLAY_QUEUE_LENGTH + 3) {
    guard++;
    const seed = pickSeed(player, fallbackSeed);
    if (!seed) break;
    const queued = await queueAutoplayTrack(client, player, seed, guildConfig);
    if (!queued) break;
    added++;
  }
  return added;
}

/** Builds the `onEmptyQueue.autoPlayFunction` lavalink-client calls the instant a guild's queue
 *  drains (before the destroy grace period even starts) - see manager.ts. This is a fallback
 *  behind the proactive top-up in events.ts's trackStart handler (which normally never lets the
 *  queue actually run dry while autoplay is on) - kept in case that ever races or fails. Needs
 *  `client` in closure for logMusic, the same reason registerPlayerEvents(client, manager) takes it. */
export function createAutoPlayFunction(client: Client) {
  return async function autoPlayFunction(player: Player, lastPlayedTrack: Track): Promise<void> {
    const guildConfig = await configManager.getEffectiveConfig(player.guildId).catch(() => null);
    if (!guildConfig) return;
    const config = zMusicConfig.parse(getPluginSettings(guildConfig, "music"));
    if (!config.autoplay_enabled) return;

    await ensureAutoplayQueueDepth(client, player, guildConfig, lastPlayedTrack);
  };
}
