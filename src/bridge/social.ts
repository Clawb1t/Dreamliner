import type { Client } from "discord.js";
import { z } from "zod";
import type { ConfigManager } from "../config/manager.js";
import {
  buildDefaultSocialEmbedConfig,
  validateSocialEmbedConfig,
  zSocialEmbedConfig,
  DEFAULT_SOCIAL_MESSAGE_CONTENT,
  type SocialEmbedConfig,
} from "../config/schemas/social.js";
import {
  YoutubeResolveError,
  fetchLatestUpload,
  resolveYoutubeChannel,
  type ResolvedYoutubeChannel,
} from "../plugins/social/functions/youtube.js";
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
import { sendNotification } from "../plugins/social/functions/notify.js";
import { isDreamlinerOneActive } from "./dreamlinerOne.js";
import { getLogger } from "../core/logger.js";
const log = getLogger("bridge");

export type BridgeSocialWatcher = {
  id: number;
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

function serializeWatcher(row: SocialWatcherRow): BridgeSocialWatcher {
  return {
    id: row.id,
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

function resolveErrorToResult(error: unknown): { ok: false; error: string; status: number } {
  if (error instanceof YoutubeResolveError) {
    return { ok: false, error: error.message, status: 422 };
  }
  log.error("[bridge] social YouTube resolve/poll error:", error);
  return { ok: false, error: "YouTube lookup failed. Try again shortly.", status: 502 };
}

export async function listBridgeSocialWatchers(
  _configManager: ConfigManager,
  guildId: string,
): Promise<BridgeResult<{ watchers: BridgeSocialWatcher[]; count: number; maxWatchers: number }>> {
  // Dashboard management (list/create/edit/delete/test) is always available, same as
  // Autoreactions — the plugin's enabled flag only gates whether the bot actually acts on
  // this at runtime (see pollAllWatchers), not whether you can configure it.
  const [watchers, count, oneActive] = await Promise.all([
    listWatchers(guildId),
    countWatchers(guildId),
    isDreamlinerOneActive(guildId),
  ]);
  return {
    ok: true,
    watchers: watchers.map(serializeWatcher),
    count,
    maxWatchers: resolveMaxWatchers(oneActive),
  };
}

export async function resolveBridgeSocialSource(
  _configManager: ConfigManager,
  _guildId: string,
  input: string,
): Promise<BridgeResult<{ channel: ResolvedYoutubeChannel }>> {
  try {
    const channel = await resolveYoutubeChannel(input);
    return { ok: true, channel };
  } catch (error) {
    return resolveErrorToResult(error);
  }
}

const zCreateInput = z.object({
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
    return { ok: false, error: "sourceInput and discordChannelId are required.", status: 400 };
  }

  const [count, oneActive] = await Promise.all([countWatchers(guildId), isDreamlinerOneActive(guildId)]);
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
    // The next poll could send the creator's current latest video once as a result.
    log.warn("[bridge] social: failed to seed checkpoint on create:", error);
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

  return { ok: true, watcher: serializeWatcher(created) };
}

const zUpdateInput = z.object({
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
  const existing = await getWatcher(guildId, id);
  if (!existing) return { ok: false, error: "No social notification with that ID.", status: 404 };

  const parsed = zUpdateInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid update payload.", status: 400 };

  const updated = await updateWatcher(guildId, id, parsed.data);
  if (!updated) return { ok: false, error: "No social notification with that ID.", status: 404 };

  return { ok: true, watcher: serializeWatcher(updated) };
}

export async function deleteBridgeSocialWatcher(
  _configManager: ConfigManager,
  guildId: string,
  id: number,
): Promise<BridgeResult<{ watcher: BridgeSocialWatcher }>> {
  const deleted = await deleteWatcher(guildId, id);
  if (!deleted) return { ok: false, error: "No social notification with that ID.", status: 404 };

  return { ok: true, watcher: serializeWatcher(deleted) };
}

export async function testSendBridgeSocialWatcher(
  client: Client,
  _configManager: ConfigManager,
  guildId: string,
  id: number,
): Promise<BridgeResult<{ sent: boolean }>> {
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
