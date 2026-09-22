import type { Client } from "discord.js";
import { z } from "zod";
import type { ConfigManager } from "../config/manager.js";
import {
  buildDefaultSocialEmbedConfig,
  buildDefaultTwitchEmbedConfig,
  validateSocialEmbedConfig,
  zSocialEmbedConfig,
  DEFAULT_SOCIAL_MESSAGE_CONTENT,
  DEFAULT_TWITCH_MESSAGE_CONTENT,
  type SocialEmbedConfig,
} from "../config/schemas/social.js";
import {
  YoutubeResolveError,
  fetchLatestUpload,
  resolveYoutubeChannel,
  type ResolvedYoutubeChannel,
} from "../plugins/social/functions/youtube.js";
import {
  TwitchResolveError,
  fetchLiveStream,
  resolveTwitchUser,
  type ResolvedTwitchUser,
} from "../plugins/social/functions/twitch.js";
import {
  ONE_WATCHERS_LIMIT,
  countWatchers,
  createWatcher,
  deleteWatcher,
  getWatcher,
  listWatchers,
  resolveMaxWatchers,
  updateWatcher,
  type SocialWatcherRow,
} from "../plugins/social/functions/store.js";
import {
  countTwitchWatchers,
  createTwitchWatcher,
  deleteTwitchWatcher,
  getTwitchWatcher,
  listTwitchWatchers,
  updateTwitchWatcher,
  type SocialTwitchWatcherRow,
} from "../plugins/social/functions/storeTwitch.js";
import { sendNotification } from "../plugins/social/functions/notify.js";
import { sendTwitchNotification } from "../plugins/social/functions/notifyTwitch.js";
import { isDreamlinerOneActive } from "./dreamlinerOne.js";
import { getLogger } from "../core/logger.js";
const log = getLogger("bridge");

export type SocialPlatform = "youtube" | "twitch";
const zSocialPlatform = z.enum(["youtube", "twitch"]);

export type BridgeSocialWatcher = {
  id: number;
  platform: SocialPlatform;
  guildId: string;
  discordChannelId: string;
  sourceChannelId: string;
  sourceChannelHandle: string | null;
  sourceChannelName: string;
  sourceChannelAvatarUrl: string | null;
  sourceChannelUrl: string;
  messageContent: string;
  mentionRoleIds: string[];
  embedConfig: SocialEmbedConfig;
  lastVideoId: string | null;
  lastVideoTitle: null;
  lastCheckedAt: string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type BridgeResult<T> = { ok: true } & T | { ok: false; error: string; status: number };

function serializeYoutubeWatcher(row: SocialWatcherRow): BridgeSocialWatcher {
  return {
    id: row.id,
    platform: "youtube",
    guildId: row.guildId,
    discordChannelId: row.discordChannelId,
    sourceChannelId: row.sourceChannelId,
    sourceChannelHandle: row.sourceChannelHandle,
    sourceChannelName: row.sourceChannelName,
    sourceChannelAvatarUrl: row.sourceChannelAvatarUrl,
    sourceChannelUrl: row.sourceChannelUrl,
    messageContent: row.messageContent,
    mentionRoleIds: row.mentionRoleIds,
    embedConfig: row.embedConfig,
    lastVideoId: row.lastVideoId,
    lastVideoTitle: null,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeTwitchWatcher(row: SocialTwitchWatcherRow): BridgeSocialWatcher {
  return {
    id: row.id,
    platform: "twitch",
    guildId: row.guildId,
    discordChannelId: row.discordChannelId,
    sourceChannelId: row.sourceUserId,
    sourceChannelHandle: `@${row.sourceUserLogin}`,
    sourceChannelName: row.sourceUserDisplayName,
    sourceChannelAvatarUrl: row.sourceUserAvatarUrl,
    sourceChannelUrl: row.sourceUserUrl,
    messageContent: row.messageContent,
    mentionRoleIds: row.mentionRoleIds,
    embedConfig: row.embedConfig,
    lastVideoId: row.lastStreamId,
    lastVideoTitle: null,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function resolveErrorToResult(error: unknown): { ok: false; error: string; status: number } {
  if (error instanceof YoutubeResolveError || error instanceof TwitchResolveError) {
    return { ok: false, error: error.message, status: 422 };
  }
  log.error("[bridge] social resolve/poll error:", error);
  return { ok: false, error: "Lookup failed. Try again shortly.", status: 502 };
}

async function countAllWatchers(guildId: string): Promise<number> {
  const [youtube, twitch] = await Promise.all([countWatchers(guildId), countTwitchWatchers(guildId)]);
  return youtube + twitch;
}

export async function listBridgeSocialWatchers(
  _configManager: ConfigManager,
  guildId: string,
): Promise<BridgeResult<{ watchers: BridgeSocialWatcher[]; count: number; maxWatchers: number }>> {
  // Dashboard management (list/create/edit/delete/test) is always available, same as
  // Autoreactions — the plugin's enabled flag only gates whether the bot actually acts on
  // this at runtime (see the poll*.ts modules), not whether you can configure it.
  const [youtubeRows, twitchRows, oneActive] = await Promise.all([
    listWatchers(guildId),
    listTwitchWatchers(guildId),
    isDreamlinerOneActive(guildId),
  ]);
  const watchers = [...youtubeRows.map(serializeYoutubeWatcher), ...twitchRows.map(serializeTwitchWatcher)];
  return {
    ok: true,
    watchers,
    count: watchers.length,
    maxWatchers: resolveMaxWatchers(oneActive),
  };
}

export async function resolveBridgeSocialSource(
  _configManager: ConfigManager,
  _guildId: string,
  platform: SocialPlatform,
  input: string,
): Promise<BridgeResult<{ channel: ResolvedYoutubeChannel | ResolvedTwitchUser }>> {
  try {
    if (platform === "youtube") return { ok: true, channel: await resolveYoutubeChannel(input) };
    return { ok: true, channel: await resolveTwitchUser(input) };
  } catch (error) {
    return resolveErrorToResult(error);
  }
}

const zCreateInput = z.object({
  platform: zSocialPlatform,
  sourceInput: z.string().min(1),
  discordChannelId: z.string().min(1),
  embedConfig: zSocialEmbedConfig.partial().optional(),
  messageContent: z.string().max(2000).optional(),
  mentionRoleIds: z.array(z.string()).max(10).optional(),
});

export async function createBridgeSocialWatcher(
  _configManager: ConfigManager,
  guildId: string,
  actorId: string,
  input: unknown,
): Promise<BridgeResult<{ watcher: BridgeSocialWatcher }>> {
  const parsed = zCreateInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "platform, sourceInput and discordChannelId are required.", status: 400 };
  }
  const { platform } = parsed.data;

  const [count, oneActive] = await Promise.all([countAllWatchers(guildId), isDreamlinerOneActive(guildId)]);
  const maxWatchers = resolveMaxWatchers(oneActive);
  if (count >= maxWatchers) {
    return {
      ok: false,
      error: oneActive
        ? `This server already has ${maxWatchers} social notifications. Remove one first.`
        : `This server already has ${maxWatchers} social notifications on the free plan. Remove one, or get Dreamliner One for up to ${ONE_WATCHERS_LIMIT}.`,
      status: 400,
    };
  }

  if (platform === "youtube") {
    let channel: ResolvedYoutubeChannel;
    try {
      channel = await resolveYoutubeChannel(parsed.data.sourceInput);
    } catch (error) {
      return resolveErrorToResult(error);
    }

    let seedVideoId: string | null = null;
    let seedPublishedAt: Date | null = null;
    try {
      const latest = await fetchLatestUpload(channel.uploadsPlaylistId);
      if (latest) {
        seedVideoId = latest.videoId;
        seedPublishedAt = latest.publishedAt;
      }
    } catch (error) {
      // Don't block creation on a transient quota/API hiccup, just skip checkpoint seeding.
      log.warn("[bridge] social: failed to seed YouTube checkpoint on create:", error);
    }

    let embedConfig: SocialEmbedConfig;
    try {
      embedConfig = parsed.data.embedConfig
        ? validateSocialEmbedConfig({ ...buildDefaultSocialEmbedConfig(), ...parsed.data.embedConfig })
        : buildDefaultSocialEmbedConfig();
    } catch {
      return { ok: false, error: "Invalid embed configuration.", status: 400 };
    }

    const created = await createWatcher({
      guildId,
      discordChannelId: parsed.data.discordChannelId,
      sourceChannelId: channel.channelId,
      sourceChannelHandle: channel.handle,
      sourceChannelName: channel.name,
      sourceChannelAvatarUrl: channel.avatarUrl,
      sourceChannelUrl: channel.url,
      uploadsPlaylistId: channel.uploadsPlaylistId,
      messageContent: parsed.data.messageContent ?? DEFAULT_SOCIAL_MESSAGE_CONTENT,
      mentionRoleIds: parsed.data.mentionRoleIds ?? [],
      embedConfig,
      lastVideoId: seedVideoId,
      lastVideoPublishedAt: seedPublishedAt,
      createdBy: actorId,
    });
    return { ok: true, watcher: serializeYoutubeWatcher(created) };
  }

  let user: ResolvedTwitchUser;
  try {
    user = await resolveTwitchUser(parsed.data.sourceInput);
  } catch (error) {
    return resolveErrorToResult(error);
  }

  // Seed the checkpoint to the current live stream (if any) so creating a watcher mid-stream
  // doesn't immediately fire a notification for a stream that's already in progress.
  let seedStreamId: string | null = null;
  let seedLiveAt: Date | null = null;
  try {
    const stream = await fetchLiveStream(user.userId);
    if (stream) {
      seedStreamId = stream.streamId;
      seedLiveAt = stream.startedAt;
    }
  } catch (error) {
    log.warn("[bridge] social: failed to seed Twitch checkpoint on create:", error);
  }

  let embedConfig: SocialEmbedConfig;
  try {
    embedConfig = parsed.data.embedConfig
      ? validateSocialEmbedConfig({ ...buildDefaultTwitchEmbedConfig(), ...parsed.data.embedConfig })
      : buildDefaultTwitchEmbedConfig();
  } catch {
    return { ok: false, error: "Invalid embed configuration.", status: 400 };
  }

  const created = await createTwitchWatcher({
    guildId,
    discordChannelId: parsed.data.discordChannelId,
    sourceUserId: user.userId,
    sourceUserLogin: user.login,
    sourceUserDisplayName: user.displayName,
    sourceUserAvatarUrl: user.avatarUrl,
    sourceUserUrl: user.url,
    messageContent: parsed.data.messageContent ?? DEFAULT_TWITCH_MESSAGE_CONTENT,
    mentionRoleIds: parsed.data.mentionRoleIds ?? [],
    embedConfig,
    lastStreamId: seedStreamId,
    lastLiveAt: seedLiveAt,
    createdBy: actorId,
  });
  return { ok: true, watcher: serializeTwitchWatcher(created) };
}

const zUpdateInput = z.object({
  platform: zSocialPlatform,
  discordChannelId: z.string().min(1).optional(),
  messageContent: z.string().max(2000).optional(),
  mentionRoleIds: z.array(z.string()).max(10).optional(),
  embedConfig: zSocialEmbedConfig.optional(),
  enabled: z.boolean().optional(),
});

export async function updateBridgeSocialWatcher(
  _configManager: ConfigManager,
  guildId: string,
  id: number,
  input: unknown,
): Promise<BridgeResult<{ watcher: BridgeSocialWatcher }>> {
  const parsed = zUpdateInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid update payload.", status: 400 };
  const { platform, ...patch } = parsed.data;

  if (platform === "youtube") {
    const existing = await getWatcher(guildId, id);
    if (!existing) return { ok: false, error: "No social notification with that ID.", status: 404 };
    const updated = await updateWatcher(guildId, id, patch);
    if (!updated) return { ok: false, error: "No social notification with that ID.", status: 404 };
    return { ok: true, watcher: serializeYoutubeWatcher(updated) };
  }

  const existing = await getTwitchWatcher(guildId, id);
  if (!existing) return { ok: false, error: "No social notification with that ID.", status: 404 };
  const updated = await updateTwitchWatcher(guildId, id, patch);
  if (!updated) return { ok: false, error: "No social notification with that ID.", status: 404 };
  return { ok: true, watcher: serializeTwitchWatcher(updated) };
}

export async function deleteBridgeSocialWatcher(
  _configManager: ConfigManager,
  guildId: string,
  platform: SocialPlatform,
  id: number,
): Promise<BridgeResult<{ watcher: BridgeSocialWatcher }>> {
  if (platform === "youtube") {
    const deleted = await deleteWatcher(guildId, id);
    if (!deleted) return { ok: false, error: "No social notification with that ID.", status: 404 };
    return { ok: true, watcher: serializeYoutubeWatcher(deleted) };
  }
  const deleted = await deleteTwitchWatcher(guildId, id);
  if (!deleted) return { ok: false, error: "No social notification with that ID.", status: 404 };
  return { ok: true, watcher: serializeTwitchWatcher(deleted) };
}

export async function testSendBridgeSocialWatcher(
  client: Client,
  _configManager: ConfigManager,
  guildId: string,
  platform: SocialPlatform,
  id: number,
): Promise<BridgeResult<{ sent: boolean }>> {
  if (platform === "youtube") {
    const watcher = await getWatcher(guildId, id);
    if (!watcher) return { ok: false, error: "No social notification with that ID.", status: 404 };
    let video;
    try {
      video = await fetchLatestUpload(watcher.uploadsPlaylistId);
    } catch (error) {
      return resolveErrorToResult(error);
    }
    const sampleVideo = video ?? {
      videoId: "dQw4w9WgXcQ",
      title: `${watcher.sourceChannelName} sample video`,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      thumbnailUrl: watcher.sourceChannelAvatarUrl ?? "",
      publishedAt: new Date(),
    };
    const sent = await sendNotification(client, watcher, sampleVideo);
    if (!sent) return { ok: false, error: "Couldn't send to that channel. Check the bot's permissions there.", status: 502 };
    return { ok: true, sent: true };
  }

  const watcher = await getTwitchWatcher(guildId, id);
  if (!watcher) return { ok: false, error: "No social notification with that ID.", status: 404 };
  let stream;
  try {
    stream = await fetchLiveStream(watcher.sourceUserId);
  } catch (error) {
    return resolveErrorToResult(error);
  }
  const sampleStream = stream ?? {
    streamId: "sample",
    title: `${watcher.sourceUserDisplayName} sample stream`,
    url: watcher.sourceUserUrl,
    thumbnailUrl: watcher.sourceUserAvatarUrl ?? "",
    gameName: "Just Chatting",
    viewerCount: 0,
    startedAt: new Date(),
  };
  const sent = await sendTwitchNotification(client, watcher, sampleStream);
  if (!sent) return { ok: false, error: "Couldn't send to that channel. Check the bot's permissions there.", status: 502 };
  return { ok: true, sent: true };
}
