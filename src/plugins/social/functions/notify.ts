import type { Client, BaseMessageOptions, Message } from "discord.js";
import type { SocialWatcherRow } from "./store.js";
import type { LatestUpload } from "./youtube.js";
import {
  interpolateTokens,
  buildNotificationPayload as buildPayload,
  sendNotification as send,
  type SendTweaks,
} from "./notifyShared.js";

/** Tokens available in the top message, every embed text field, and button URLs. */
export const SOCIAL_TOKENS = [
  "video_title",
  "video_url",
  "video_thumbnail",
  "video_id",
  "published_at",
  "upload_type",
  "channel_name",
  "channel_handle",
  "channel_url",
  "channel_avatar",
] as const;
export type SocialTokenKey = (typeof SOCIAL_TOKENS)[number];

/** An upload plus what kind it is ("video", "Short", "livestream", "premiere"). */
export type NotifiableUpload = LatestUpload & { typeLabel?: string };

export function buildSocialTokens(watcher: SocialWatcherRow, video: NotifiableUpload): Record<SocialTokenKey, string> {
  return {
    video_title: video.title,
    video_url: video.url,
    video_thumbnail: video.thumbnailUrl,
    video_id: video.videoId,
    published_at: `<t:${Math.floor(video.publishedAt.getTime() / 1000)}:R>`,
    upload_type: video.typeLabel ?? "video",
    channel_name: watcher.sourceChannelName,
    channel_handle: watcher.sourceChannelHandle ?? "",
    channel_url: watcher.sourceChannelUrl,
    channel_avatar: watcher.sourceChannelAvatarUrl ?? "",
  };
}

export const interpolateSocialTokens: (text: string, tokens: Record<SocialTokenKey, string>) => string = interpolateTokens;

export function buildNotificationPayload(watcher: SocialWatcherRow, video: NotifiableUpload, tweaks?: SendTweaks): BaseMessageOptions {
  const tokens = buildSocialTokens(watcher, video);
  return buildPayload(watcher, tokens, "channel_avatar", "video_thumbnail", video.publishedAt, tweaks);
}

/** Send a video notification for a watcher. Never throws; logs and returns null on failure. */
export async function sendNotification(
  client: Client,
  watcher: SocialWatcherRow,
  video: NotifiableUpload,
  tweaks?: SendTweaks,
): Promise<Message | null> {
  const tokens = buildSocialTokens(watcher, video);
  return send(client, watcher, tokens, "channel_avatar", "video_thumbnail", video.publishedAt, tweaks);
}
