import type { Client, BaseMessageOptions } from "discord.js";
import type { SocialTwitchWatcherRow } from "./storeTwitch.js";
import type { LiveStream } from "./twitch.js";
import { buildNotificationPayload as buildPayload, sendNotification as send } from "./notifyShared.js";

/** Tokens available in the top message, every embed text field, and button URLs. */
export const SOCIAL_TWITCH_TOKENS = [
  "stream_title",
  "stream_url",
  "stream_thumbnail",
  "game_name",
  "viewer_count",
  "started_at",
  "streamer_name",
  "streamer_handle",
  "streamer_url",
  "streamer_avatar",
] as const;
export type SocialTwitchTokenKey = (typeof SOCIAL_TWITCH_TOKENS)[number];

export function buildTwitchTokens(watcher: SocialTwitchWatcherRow, stream: LiveStream): Record<SocialTwitchTokenKey, string> {
  return {
    stream_title: stream.title,
    stream_url: stream.url,
    stream_thumbnail: stream.thumbnailUrl,
    game_name: stream.gameName,
    viewer_count: String(stream.viewerCount),
    started_at: `<t:${Math.floor(stream.startedAt.getTime() / 1000)}:R>`,
    streamer_name: watcher.sourceUserDisplayName,
    streamer_handle: `@${watcher.sourceUserLogin}`,
    streamer_url: watcher.sourceUserUrl,
    streamer_avatar: watcher.sourceUserAvatarUrl ?? "",
  };
}

export function buildTwitchNotificationPayload(watcher: SocialTwitchWatcherRow, stream: LiveStream): BaseMessageOptions {
  const tokens = buildTwitchTokens(watcher, stream);
  return buildPayload(watcher, tokens, "streamer_avatar", "stream_thumbnail");
}

/** Send a "went live" notification for a watcher. Never throws; logs and returns false on failure. */
export async function sendTwitchNotification(client: Client, watcher: SocialTwitchWatcherRow, stream: LiveStream): Promise<boolean> {
  const tokens = buildTwitchTokens(watcher, stream);
  return send(client, watcher, tokens, "streamer_avatar", "stream_thumbnail");
}
