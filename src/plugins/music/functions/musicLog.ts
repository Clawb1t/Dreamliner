import type { Client } from "discord.js";
import { sendServerLog } from "../../../core/logging/send.js";
import { buildGenericServerLog } from "../../../core/logging/format.js";
import type { LogEmojiCategory } from "../../../core/logging/types.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import type { LogEventType } from "../../../core/logging/events.js";

export type MusicLogEventType =
  | "music_play"
  | "music_skip"
  | "music_stop"
  | "music_playback"
  | "music_queue"
  | "music_filter"
  | "music_dj"
  | "music_playlist"
  | "music_settings"
  | "music_session"
  | "music_error";

const DEFAULT_EMOJI: Record<MusicLogEventType, LogEmojiCategory> = {
  music_play: "create",
  music_skip: "action",
  music_stop: "leave",
  music_playback: "edit",
  music_queue: "edit",
  music_filter: "edit",
  music_dj: "serverUpdate",
  music_playlist: "create",
  music_settings: "serverUpdate",
  music_session: "voice",
  music_error: "modDefault",
};

/** Single entry point for every music log card - covers whatever happens with the music system
 *  (Discord commands, the web player, and system-driven events like retries or 24/7 reconnects),
 *  so every call site stays a one-liner instead of re-deriving the card/send boilerplate. Never
 *  throws - a logging failure shouldn't break playback. */
export async function logMusic(
  client: Client,
  guildConfig: GuildConfig,
  guildId: string,
  eventType: MusicLogEventType,
  title: string,
  lines: string[],
  options?: {
    actorId?: string | null;
    targetId?: string | null;
    channelId?: string | null;
    avatarUrl?: string | null;
    emojiCategory?: LogEmojiCategory;
  },
): Promise<void> {
  try {
    const card = buildGenericServerLog(title, lines, options?.avatarUrl ?? null, options?.emojiCategory ?? DEFAULT_EMOJI[eventType]);
    await sendServerLog(client, guildConfig, card, {
      guildId,
      eventType: eventType as LogEventType,
      summary: title,
      actorId: options?.actorId ?? null,
      targetId: options?.targetId ?? null,
      channelId: options?.channelId ?? null,
    });
  } catch {
    // Logging is best-effort - a broken log channel or a transient DB error must never take
    // playback down with it.
  }
}
