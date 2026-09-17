import { eq } from "drizzle-orm";
import { ChannelType, type Client } from "discord.js";
import type { Player, Track } from "lavalink-client";
import { getDb } from "../../../db/client.js";
import { musicSessions, musicQueueItems } from "../../../db/schema.js";
import { getLogger } from "../../../core/logger.js";
import { claimVoiceSession } from "../../../core/voiceSessionRegistry.js";
import { getLavalinkManager, isLavalinkConfigured } from "./manager.js";
import { configManager } from "../../../config/manager.js";
import { logMusic } from "./musicLog.js";

const log = getLogger("music");

/** How often position-only updates get flushed to the DB - track/queue/pause/volume/loop changes
 *  flush immediately instead (see saveSessionNow's direct callers), since those are rare and
 *  matter more than losing a few seconds of playback position on a crash. */
const THROTTLE_MS = 10_000;
const pendingTimers = new Map<string, NodeJS.Timeout>();

type QueueItemRow = typeof musicQueueItems.$inferSelect;

function requesterOf(track: Track): string | undefined {
  return (track.requester as { id?: string } | undefined)?.id;
}

function trackFromRow(row: QueueItemRow): Track {
  return {
    encoded: row.encoded,
    info: {
      identifier: row.encoded,
      title: row.title,
      author: row.author ?? "",
      duration: row.durationMs,
      artworkUrl: row.artworkUrl,
      uri: row.uri ?? "",
      sourceName: (row.sourceName ?? "http") as Track["info"]["sourceName"],
      isSeekable: true,
      isStream: false,
      isrc: null,
    },
    pluginInfo: {},
    requester: row.requestedBy ? { id: row.requestedBy } : undefined,
  };
}

/** Immediate write-through - call this on track/queue/pause/volume/loop changes. */
export async function saveSessionNow(player: Player): Promise<void> {
  const existing = pendingTimers.get(player.guildId);
  if (existing) {
    clearTimeout(existing);
    pendingTimers.delete(player.guildId);
  }

  const db = getDb();
  const current = player.queue.current;
  const now = new Date();

  const sessionValues = {
    guildId: player.guildId,
    voiceChannelId: player.voiceChannelId ?? "",
    textChannelId: player.textChannelId ?? "",
    currentTrackEncoded: current?.encoded ?? null,
    currentTrackTitle: current?.info.title ?? null,
    currentTrackAuthor: current?.info.author ?? null,
    currentTrackUri: current?.info.uri ?? null,
    currentTrackArtworkUrl: current?.info.artworkUrl ?? null,
    currentTrackDurationMs: current?.info.duration ?? null,
    currentTrackSourceName: current?.info.sourceName ?? null,
    currentTrackRequestedBy: current ? (requesterOf(current) ?? null) : null,
    positionMs: Math.round(player.position),
    volume: player.volume,
    paused: player.paused,
    loopMode: player.repeatMode,
    updatedAt: now,
  };

  await db
    .insert(musicSessions)
    .values(sessionValues)
    .onConflictDoUpdate({ target: [musicSessions.guildId], set: sessionValues });

  await db.delete(musicQueueItems).where(eq(musicQueueItems.guildId, player.guildId));
  const queued = player.queue.tracks.filter((t): t is Track => !("resolve" in t));
  if (queued.length > 0) {
    await db.insert(musicQueueItems).values(
      queued.map((track, index) => ({
        guildId: player.guildId,
        position: index,
        encoded: track.encoded ?? "",
        title: track.info.title,
        author: track.info.author,
        uri: track.info.uri,
        artworkUrl: track.info.artworkUrl,
        durationMs: track.info.duration,
        sourceName: track.info.sourceName,
        requestedBy: requesterOf(track) ?? "unknown",
      })),
    );
  }
}

/** Throttled position-only save - coalesces frequent playerUpdate ticks into one write per
 *  THROTTLE_MS instead of hammering the DB every few seconds. */
export function scheduleSave(player: Player): void {
  if (pendingTimers.has(player.guildId)) return;
  const timer = setTimeout(() => {
    pendingTimers.delete(player.guildId);
    void saveSessionNow(player).catch((error: unknown) =>
      log.error(`Failed to save music session for guild ${player.guildId}:`, error),
    );
  }, THROTTLE_MS);
  pendingTimers.set(player.guildId, timer);
}

export async function deleteSession(guildId: string): Promise<void> {
  const timer = pendingTimers.get(guildId);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(guildId);
  }
  const db = getDb();
  await db.delete(musicQueueItems).where(eq(musicQueueItems.guildId, guildId));
  await db.delete(musicSessions).where(eq(musicSessions.guildId, guildId));
}

const VALID_LOOP_MODES = new Set(["off", "track", "queue"]);

/** Called once from the music plugin's onLoad - rejoins and resumes every guild that had an
 *  active player when the bot last stopped. */
export async function resumeSessionsOnBoot(client: Client): Promise<void> {
  if (!isLavalinkConfigured()) return;
  const db = getDb();
  const sessions = await db.select().from(musicSessions).all();
  if (sessions.length === 0) return;

  log.info(`Resuming ${sessions.length} music session(s) from the last run...`);
  const manager = getLavalinkManager();

  for (const session of sessions) {
    try {
      const guild = await client.guilds.fetch(session.guildId).catch(() => null);
      if (!guild) {
        await deleteSession(session.guildId);
        continue;
      }
      const channel = await guild.channels.fetch(session.voiceChannelId).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        await deleteSession(session.guildId);
        continue;
      }

      const claim = claimVoiceSession(session.guildId, session.voiceChannelId, "music");
      if (!claim.ok) {
        log.warn(`Skipping music resume for guild ${session.guildId} - voice already claimed by ${claim.ownedBy}.`);
        continue;
      }

      const player = manager.createPlayer({
        guildId: session.guildId,
        voiceChannelId: session.voiceChannelId,
        textChannelId: session.textChannelId,
        selfDeaf: true,
        selfMute: false,
        volume: session.volume,
      });
      await player.connect();

      const queueRows = await db
        .select()
        .from(musicQueueItems)
        .where(eq(musicQueueItems.guildId, session.guildId))
        .orderBy(musicQueueItems.position)
        .all();
      if (queueRows.length > 0) {
        await player.queue.add(queueRows.map(trackFromRow));
      }
      if (VALID_LOOP_MODES.has(session.loopMode)) {
        await player.setRepeatMode(session.loopMode as "off" | "track" | "queue");
      }

      if (session.currentTrackEncoded) {
        await player.play({
          track: {
            encoded: session.currentTrackEncoded,
            requester: session.currentTrackRequestedBy ? { id: session.currentTrackRequestedBy } : undefined,
          },
          position: session.positionMs,
          paused: session.paused,
        });
        log.info(`Resumed music session for guild ${session.guildId} at ${Math.round(session.positionMs / 1000)}s.`);
      } else if (queueRows.length > 0) {
        await player.play();
      }

      const guildConfig = await configManager.getEffectiveConfig(session.guildId).catch(() => null);
      if (guildConfig) {
        void logMusic(client, guildConfig, session.guildId, "music_session", "Music - Resumed After Restart", [
          `Channel: <#${session.voiceChannelId}>`,
          session.currentTrackTitle ? `Track: **${session.currentTrackTitle}** at ${Math.round(session.positionMs / 1000)}s` : "No track was playing - resumed idle",
        ]);
      }
    } catch (error) {
      log.error(`Failed to resume music session for guild ${session.guildId}:`, error);
      await deleteSession(session.guildId).catch(() => {});
      const guildConfig = await configManager.getEffectiveConfig(session.guildId).catch(() => null);
      if (guildConfig) {
        void logMusic(client, guildConfig, session.guildId, "music_error", "Music - Resume After Restart Failed", [
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        ]);
      }
    }
  }
}
