import type { Client, TextBasedChannel } from "discord.js";
import type { LavalinkManager, Track } from "lavalink-client";
import { getLogger } from "../../../core/logger.js";
import { configManager } from "../../../config/manager.js";
import { zMusicConfig } from "../../../config/schemas/music.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { baseEmbed } from "../../../core/embeds.js";
import { containerReply, containersReply } from "../../../core/responses.js";
import { buildTrackContainer, buildWebPlayerAnnounceContainer, trackFailedLine } from "./formatting.js";
import { nextCandidate, takeFallbackSourceAttempt, clearRetryPlan } from "./retryQueue.js";
import { releaseVoiceSession } from "../../../core/voiceSessionRegistry.js";
import { getOrConnectPlayer } from "./player.js";
import { saveSessionNow, scheduleSave, deleteSession } from "./sessionPersistence.js";
import { hasAnnouncedWebPlayer, markWebPlayerAnnounced, clearWebPlayerAnnounced } from "./webPlayerAnnounce.js";
import { logMusic } from "./musicLog.js";

/** destroy() reasons issued by our own commands/bridge - playerDestroy already gets its own
 *  music_stop log at those call sites, so the generic handler below skips these to avoid a
 *  duplicate entry and only logs system-driven destroys (queue-empty timeout, reconnect fail, ...). */
const COMMAND_INITIATED_DESTROY_REASONS = new Set(["stopped via /stop", "left via /leave", "stopped from the web player"]);

const log = getLogger("music");

async function send(client: Client, channelId: string | null | undefined, line: string): Promise<void> {
  if (!channelId) return;
  try {
    const channel = (await client.channels.fetch(channelId).catch(() => null)) as TextBasedChannel | null;
    if (channel?.isSendable()) await channel.send(containerReply(baseEmbed().setDescription(line)));
  } catch (error) {
    log.error(`Failed to send music message in channel ${channelId}:`, error);
  }
}

/** Posts the opt-in now-playing announcement. Rides along in the same message as the "manage
 *  online" container on the first track of a session (instead of a separate message) when that
 *  hasn't been shown yet. */
async function sendNowPlaying(client: Client, channelId: string | null | undefined, guildId: string, track: Track): Promise<void> {
  if (!channelId) return;
  try {
    const channel = (await client.channels.fetch(channelId).catch(() => null)) as TextBasedChannel | null;
    if (!channel?.isSendable()) return;
    const trackEntry = buildTrackContainer(track, { kind: "now_playing" });
    if (!hasAnnouncedWebPlayer(guildId)) {
      markWebPlayerAnnounced(guildId);
      await channel.send(containersReply([trackEntry, buildWebPlayerAnnounceContainer(guildId)]));
      return;
    }
    await channel.send(containerReply(trackEntry.container, false, trackEntry.row ? [trackEntry.row] : undefined));
  } catch (error) {
    log.error(`Failed to send now-playing announcement in channel ${channelId}:`, error);
  }
}

/** Fallback for sessions with no user-facing reply to attach a second container to (boot resume,
 *  24/7 reconnect) - sends the "manage online" container on its own, once per session. */
async function sendWebPlayerLinkFallback(client: Client, channelId: string | null | undefined, guildId: string): Promise<void> {
  if (!channelId) return;
  try {
    const channel = (await client.channels.fetch(channelId).catch(() => null)) as TextBasedChannel | null;
    if (!channel?.isSendable()) return;
    const { container, row } = buildWebPlayerAnnounceContainer(guildId);
    await channel.send(containerReply(container, false, [row]));
  } catch (error) {
    log.error(`Failed to send web player link in channel ${channelId}:`, error);
  }
}

/**
 * Wires playback-lifecycle visibility. Two distinct concerns:
 *  - trackStart's own "now playing" line is OPT-IN (announce_now_playing config), posted to a
 *    dedicated announce channel if set — the /play command's own reply already covers the common
 *    "I just ran /play and want to see what happened" case, so this isn't a duplicate by default.
 *  - track failures (trackError/trackStuck) always announce in the player's text channel
 *    regardless of that setting — a silent failure followed by the bot just leaving (the old,
 *    confusing behavior) is worse than one extra message.
 */
export function registerPlayerEvents(client: Client, manager: LavalinkManager): void {
  manager.on("trackStart", (player, track) => {
    if (!track) return;
    clearRetryPlan(player.guildId);
    void saveSessionNow(player).catch((error: unknown) =>
      log.error(`Failed to save music session for guild ${player.guildId}:`, error),
    );

    void (async () => {
      const guildConfig = await configManager.getEffectiveConfig(player.guildId).catch(() => null);
      const config = guildConfig ? zMusicConfig.parse(getPluginSettings(guildConfig, "music")) : null;

      if (config?.announce_now_playing) {
        const channelId = config.announce_channel_id || player.textChannelId;
        await sendNowPlaying(client, channelId, player.guildId, track);
        return;
      }

      // No announce message to ride along in - if nothing else (e.g. /play's own reply) has
      // shown the web player link for this session yet, send it on its own so sessions started
      // without a user-facing reply (boot resume, 24/7 reconnect) still get it.
      if (!hasAnnouncedWebPlayer(player.guildId)) {
        markWebPlayerAnnounced(player.guildId);
        await sendWebPlayerLinkFallback(client, player.textChannelId, player.guildId);
      }
    })();
  });

  manager.on("playerUpdate", (_oldPlayerJson, player) => {
    if (player.queue.current) scheduleSave(player);
  });

  manager.on("playerDestroy", (player, destroyReason) => {
    releaseVoiceSession(player.guildId, "music");
    clearWebPlayerAnnounced(player.guildId);

    void (async () => {
      const guildConfig = await configManager.getEffectiveConfig(player.guildId).catch(() => null);
      const config = guildConfig ? zMusicConfig.parse(getPluginSettings(guildConfig, "music")) : null;

      if (destroyReason === "QueueEmpty" && player.voiceChannelId && player.textChannelId) {
        if (config?.stay_connected_247) {
          const rejoin = await getOrConnectPlayer(player.guildId, player.voiceChannelId, player.textChannelId);
          if (rejoin.ok) {
            log.info(`24/7 mode: rejoined voice in guild ${player.guildId} after the queue emptied.`);
            if (guildConfig) {
              void logMusic(client, guildConfig, player.guildId, "music_session", "Music - 24/7 Reconnected", [
                "Queue emptied - reconnected to stay in the voice channel (24/7 mode)",
                `Channel: <#${player.voiceChannelId}>`,
              ]);
            }
            return;
          }
          log.warn(`24/7 mode couldn't rejoin voice in guild ${player.guildId}: ${rejoin.reason}`);
          if (guildConfig) {
            void logMusic(client, guildConfig, player.guildId, "music_error", "Music - 24/7 Reconnect Failed", [
              `Reason: ${rejoin.reason}`,
            ]);
          }
        }
      }

      if (guildConfig && !COMMAND_INITIATED_DESTROY_REASONS.has(String(destroyReason))) {
        void logMusic(client, guildConfig, player.guildId, "music_session", "Music - Session Ended", [
          `Reason: ${String(destroyReason ?? "unknown")}`,
        ]);
      }

      await deleteSession(player.guildId).catch((error: unknown) =>
        log.error(`Failed to delete music session for guild ${player.guildId}:`, error),
      );
    })();
  });

  async function logTrackError(guildId: string, title: string, lines: string[]): Promise<void> {
    const guildConfig = await configManager.getEffectiveConfig(guildId).catch(() => null);
    if (guildConfig) void logMusic(client, guildConfig, guildId, "music_error", title, lines);
  }

  manager.on("trackError", (player, track, payload) => {
    const reason = payload.exception?.message ?? "unknown error";
    log.error(`Track error in guild ${player.guildId}: ${reason} (${track?.info.title ?? "unknown track"})`);
    const trackLine = track ? `Track: **${track.info.title}**${track.info.author ? ` - ${track.info.author}` : ""}` : "Track: (unknown)";

    // Only auto-retry the "just started playing, nothing else queued" case - if there's a real
    // queue behind it, autoSkip already advances to the next real track, which is more useful
    // than substituting a retry of the one that just failed.
    if (player.queue.tracks.length === 0) {
      const candidate = nextCandidate(player.guildId);
      if (candidate) {
        log.info(`Retrying with next search result in guild ${player.guildId}: ${candidate.info.title}`);
        void player
          .play({ track: { encoded: candidate.encoded, requester: candidate.requester } })
          .catch((error: unknown) => log.error(`Retry failed in guild ${player.guildId}:`, error));
        void logTrackError(player.guildId, "Music - Track Error (Retried)", [trackLine, `Error: ${reason}`, `Retrying with: **${candidate.info.title}**`]);
        return;
      }

      // Every result from the original search failed - that points at a source-wide problem
      // (YouTube's intermittent bot-wall, a SoundCloud outage) rather than one bad track, so try
      // a completely different source for the same query instead of giving up.
      const fallback = takeFallbackSourceAttempt(player.guildId);
      if (fallback) {
        void (async () => {
          try {
            const result = await player.search({ query: fallback.query, source: "scsearch" }, { id: fallback.requesterId });
            const next = result.tracks[0];
            if (!next) {
              void send(client, player.textChannelId, trackFailedLine(track, reason));
              void logTrackError(player.guildId, "Music - Track Error (Exhausted)", [trackLine, `Error: ${reason}`, "No fallback source results - skipped"]);
              return;
            }
            next.requester = { id: fallback.requesterId };
            log.info(`Falling back to SoundCloud in guild ${player.guildId}: ${next.info.title}`);
            await player.play({ track: { encoded: next.encoded, requester: next.requester } });
            void logTrackError(player.guildId, "Music - Track Error (Fallback Source)", [trackLine, `Error: ${reason}`, `Falling back to SoundCloud: **${next.info.title}**`]);
          } catch (error) {
            log.error(`Fallback-source retry failed in guild ${player.guildId}:`, error);
            void send(client, player.textChannelId, trackFailedLine(track, reason));
            void logTrackError(player.guildId, "Music - Track Error (Exhausted)", [trackLine, `Error: ${reason}`, "Fallback source retry also failed - skipped"]);
          }
        })();
        return;
      }
    }

    void send(client, player.textChannelId, trackFailedLine(track, reason));
    void logTrackError(player.guildId, "Music - Track Error", [trackLine, `Error: ${reason}`, "Skipped"]);
  });

  manager.on("trackStuck", (player, track, payload) => {
    log.warn(`Track stuck in guild ${player.guildId} after ${payload.thresholdMs}ms: ${track?.info.title ?? "unknown track"}`);
    void send(client, player.textChannelId, trackFailedLine(track, "got stuck"));
    const trackLine = track ? `Track: **${track.info.title}**${track.info.author ? ` - ${track.info.author}` : ""}` : "Track: (unknown)";
    void logTrackError(player.guildId, "Music - Track Stuck", [trackLine, `Stuck for: ${Math.round(payload.thresholdMs / 1000)}s`, "Skipped"]);
  });

  manager.on("playerSocketClosed", (player, payload) => {
    // 4014 = the bot was disconnected/moved/kicked from the voice channel by Discord itself
    // (moderator action, channel deleted, etc.) - not a Lavalink-side failure, nothing to announce.
    if (payload.code === 4014) return;
    log.warn(`Player voice socket closed in guild ${player.guildId}: code=${payload.code} reason=${payload.reason}`);
  });
}
