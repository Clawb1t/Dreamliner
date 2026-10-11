import type { Player } from "lavalink-client";
import type { MusicConfig } from "../../../config/schemas/music.js";

/** The server's channel restrictions, for every way music starts (commands and the web player).
 *  Returns why it's not allowed, or null. */
export function musicChannelBlock(config: MusicConfig, voiceChannelId: string, textChannelId?: string | null): string | null {
  if (config.allowed_voice_channels.length > 0 && !config.allowed_voice_channels.includes(voiceChannelId)) {
    return "Music can't be played in that voice channel here.";
  }
  if (textChannelId && config.allowed_text_channels.length > 0 && !config.allowed_text_channels.includes(textChannelId)) {
    return "Music commands can't be used in this channel.";
  }
  return null;
}

/** The server's queue size and track length limits. Returns why a track can't be queued, or null. */
export function musicTrackBlock(config: MusicConfig, player: Player, durationMs: number | null | undefined): string | null {
  const queueSize = player.queue.tracks.length + (player.queue.current ? 1 : 0);
  if (queueSize >= config.max_queue_size) return "The queue is full.";
  if (config.max_track_duration_minutes > 0 && (durationMs ?? 0) > config.max_track_duration_minutes * 60_000) {
    return `Tracks longer than ${config.max_track_duration_minutes} minutes aren't allowed here.`;
  }
  return null;
}
