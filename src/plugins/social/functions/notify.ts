import type { Client, BaseMessageOptions } from "discord.js";
import type { SocialWatcherRow } from "./store.js";
import type { LatestUpload } from "./youtube.js";
import { interpolateTokens, buildNotificationPayload as buildPayload, sendNotification as send } from "./notifyShared.js";

/** Tokens available in the top message, every embed text field, and button URLs. */
export const SOCIAL_TOKENS = [
  "video_title",
  "video_url",
  "video_thumbnail",
  "video_id",
  "published_at",
  "channel_name",
  "channel_handle",
  "channel_url",
  "channel_avatar",
] as const;
export type SocialTokenKey = (typeof SOCIAL_TOKENS)[number];

export function buildSocialTokens(watcher: SocialWatcherRow, video: LatestUpload): Record<SocialTokenKey, string> {
  return {
    video_title: video.title,
    video_url: video.url,
    video_thumbnail: video.thumbnailUrl,
    video_id: video.videoId,
    published_at: `<t:${Math.floor(video.publishedAt.getTime() / 1000)}:R>`,
    channel_name: watcher.sourceChannelName,
    channel_handle: watcher.sourceChannelHandle ?? "",
    channel_url: watcher.sourceChannelUrl,
    channel_avatar: watcher.sourceChannelAvatarUrl ?? "",
  };
}

export const interpolateSocialTokens: (text: string, tokens: Record<SocialTokenKey, string>) => string = interpolateTokens;

export function buildNotificationPayload(watcher: SocialWatcherRow, video: LatestUpload): BaseMessageOptions {
  const tokens = buildSocialTokens(watcher, video);
  return buildPayload(watcher, tokens, "channel_avatar", "video_thumbnail");
}

/** Send a video notification for a watcher. Never throws; logs and returns false on failure. */
export async function sendNotification(client: Client, watcher: SocialWatcherRow, video: LatestUpload): Promise<boolean> {
  const tokens = buildSocialTokens(watcher, video);
  return send(client, watcher, tokens, "channel_avatar", "video_thumbnail");
}
