import { createHash } from "node:crypto";
import type { Client } from "discord.js";
import { z } from "zod";
import type { ConfigManager } from "../config/manager.js";
import {
  buildDefaultSocialEmbedConfig,
  buildDefaultTwitchEmbedConfig,
  parseSocialWatcherOptions,
  validateSocialEmbedConfig,
  zSocialEmbedConfig,
  zSocialWatcherOptions,
  DEFAULT_SOCIAL_MESSAGE_CONTENT,
  DEFAULT_TWITCH_MESSAGE_CONTENT,
  type SocialEmbedConfig,
  type SocialWatcherOptions,
} from "../config/schemas/social.js";
import {
  YoutubeResolveError,
  fetchChannelsInfo,
  fetchLatestUpload,
  fetchRecentUploadIds,
  fetchVideoDetails,
  resolveYoutubeChannel,
  type ChannelInfo,
  type ResolvedYoutubeChannel,
  type VideoDetails,
} from "../plugins/social/functions/youtube.js";
import {
  TwitchResolveError,
  fetchLiveStream,
  fetchLiveStreams,
  fetchTwitchUsers,
  resolveTwitchUser,
  searchTwitchChannels,
  type LiveStream,
  type ResolvedTwitchUser,
  type TwitchUserInfo,
} from "../plugins/social/functions/twitch.js";
import {
  ONE_WATCHERS_LIMIT,
  countWatchers,
  createWatcher,
  deleteWatcher,
  getWatcher,
  listWatchers,
  refreshWatcherProfile,
  resolveMaxWatchers,
  updateCheckpoint,
  updateWatcher,
  type SocialWatcherRow,
} from "../plugins/social/functions/store.js";
import {
  countTwitchWatchers,
  createTwitchWatcher,
  deleteTwitchWatcher,
  getTwitchWatcher,
  listTwitchWatchers,
  refreshTwitchWatcherProfile,
  reseedTwitchCheckpoint,
  updateTwitchWatcher,
  type SocialTwitchWatcherRow,
} from "../plugins/social/functions/storeTwitch.js";
import {
  STATS_DAYS,
  deleteWatcherDeliveries,
  guildSocialStats,
  openTwitchSession,
  recentGuildSocialDeliveries,
  statsKey,
  updateDelivery,
  type SocialWatcherStats,
} from "../plugins/social/functions/deliveries.js";
import { isValidTimeZone, uploadKindLabel, classifyUpload } from "../plugins/social/functions/logic.js";
import { MILESTONE_UNSEEDED } from "../plugins/social/functions/logic.js";
import { seedYoutubeMilestone } from "../plugins/social/functions/milestoneNotify.js";
import { sendNotification } from "../plugins/social/functions/notify.js";
import { sendTwitchNotification } from "../plugins/social/functions/notifyTwitch.js";
import { cached, cachedSwr } from "./responseCache.js";
import { mapWithConcurrency } from "../core/concurrency.js";
import { SlidingWindowLimiter } from "./rateLimit.js";
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
  options: SocialWatcherOptions;
  lastVideoId: string | null;
  lastVideoTitle: null;
  lastCheckedAt: string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type BridgeResult<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };

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
    options: row.options,
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
    options: row.options,
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

const NOT_FOUND = { ok: false as const, error: "No social notification with that ID.", status: 404 };

// ---------------------------------------------------------------------------------------------
// List (+ stats)
// ---------------------------------------------------------------------------------------------

export type BridgeSocialTotals = {
  creators: number;
  delivered30d: number;
  deliveredAll: number;
  daily: number[];
};

export type BridgeSocialDelivery = {
  id: number;
  platform: SocialPlatform;
  watcherId: number;
  creatorName: string;
  avatarUrl: string | null;
  channelId: string;
  kind: string;
  title: string;
  url: string;
  thumbnailUrl: string | null;
  messageUrl: string | null;
  endedAt: string | null;
  createdAt: string;
};

export async function listBridgeSocialWatchers(
  _configManager: ConfigManager,
  guildId: string,
): Promise<
  BridgeResult<{
    watchers: BridgeSocialWatcher[];
    count: number;
    maxWatchers: number;
    stats: Record<string, SocialWatcherStats>;
    totals: BridgeSocialTotals;
    recent: BridgeSocialDelivery[];
    platforms: { youtube: boolean; twitch: boolean; twitchMilestones: boolean };
  }>
> {
  // Dashboard management (list/create/edit/delete/test) is always available, same as
  // Autoreactions. The plugin's enabled flag only gates whether the bot actually acts on
  // this at runtime (see the poll*.ts modules), not whether you can configure it.
  const [youtubeRows, twitchRows, oneActive] = await Promise.all([
    listWatchers(guildId),
    listTwitchWatchers(guildId),
    isDreamlinerOneActive(guildId),
  ]);
  const watchers = [...youtubeRows.map(serializeYoutubeWatcher), ...twitchRows.map(serializeTwitchWatcher)];
  const [statsMap, recentRows] = await Promise.all([
    guildSocialStats(guildId, [
      ...youtubeRows.map((row) => ({ platform: "youtube" as const, id: row.id, deliveredCount: row.deliveredCount })),
      ...twitchRows.map((row) => ({ platform: "twitch" as const, id: row.id, deliveredCount: row.deliveredCount })),
    ]),
    recentGuildSocialDeliveries(guildId, 10),
  ]);

  const stats: Record<string, SocialWatcherStats> = {};
  const totals: BridgeSocialTotals = {
    creators: new Set(watchers.map((w) => `${w.platform}:${w.sourceChannelId}`)).size,
    delivered30d: 0,
    deliveredAll: 0,
    daily: Array<number>(STATS_DAYS).fill(0),
  };
  for (const [key, entry] of statsMap) {
    stats[key] = entry;
    totals.delivered30d += entry.delivered30d;
    totals.deliveredAll += entry.deliveredAll;
    entry.daily.forEach((n, i) => {
      totals.daily[i] = (totals.daily[i] ?? 0) + n;
    });
  }

  const byKey = new Map(watchers.map((w) => [statsKey(w.platform, w.id), w]));
  const recent: BridgeSocialDelivery[] = [];
  for (const row of recentRows) {
    const watcher = byKey.get(statsKey(row.platform as SocialPlatform, row.watcherId));
    if (!watcher) continue;
    recent.push({
      id: row.id,
      platform: watcher.platform,
      watcherId: watcher.id,
      creatorName: watcher.sourceChannelName,
      avatarUrl: watcher.sourceChannelAvatarUrl,
      channelId: row.channelId,
      kind: row.kind,
      title: row.title,
      url: row.url,
      thumbnailUrl: row.thumbnailUrl,
      messageUrl: row.messageId ? `https://discord.com/channels/${guildId}/${row.channelId}/${row.messageId}` : null,
      endedAt: row.endedAt ? row.endedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    });
  }

  return {
    ok: true,
    watchers,
    count: watchers.length,
    maxWatchers: resolveMaxWatchers(oneActive),
    stats,
    totals,
    recent,
    platforms: {
      youtube: Boolean(process.env.YOUTUBE_API_KEY?.trim()),
      twitch: Boolean(process.env.TWITCH_CLIENT_ID?.trim() && process.env.TWITCH_CLIENT_SECRET?.trim()),
      // Helix only gives follower totals to the broadcaster's own login, not to an app token.
      twitchMilestones: false,
    },
  };
}

export async function resolveBridgeSocialSource(
  _configManager: ConfigManager,
  _guildId: string,
  platform: SocialPlatform,
  input: string,
): Promise<BridgeResult<{ channel: ResolvedYoutubeChannel | ResolvedTwitchUser }>> {
  try {
    // Cached so re-submitting the same handle (or two people adding the same creator) costs nothing.
    const key = `social:resolve:${platform}:${input.trim().toLowerCase()}`;
    if (platform === "youtube") return { ok: true, channel: await cached(key, 10 * 60_000, () => resolveYoutubeChannel(input)) };
    return { ok: true, channel: await cached(key, 10 * 60_000, () => resolveTwitchUser(input)) };
  } catch (error) {
    return resolveErrorToResult(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

/** Options as sent by the dashboard: any subset, merged over the stored ones. */
const zOptionsInput = zSocialWatcherOptions.partial().optional();

/**
 * Merge incoming options over the stored ones. `milestone_last` is the bot's own bookkeeping, so
 * the dashboard can't set it: switching milestones on seeds it from the channel's current count
 * (so old milestones never fire), switching off resets it.
 */
async function mergeOptions(
  platform: SocialPlatform,
  sourceId: string,
  current: SocialWatcherOptions,
  incoming: Partial<SocialWatcherOptions> | undefined,
): Promise<SocialWatcherOptions | { error: string }> {
  if (!incoming) return current;
  const { milestone_last: _ignored, ...rest } = incoming;
  const next = parseSocialWatcherOptions({ ...current, ...rest, milestone_last: current.milestone_last });
  if (next.quiet_enabled && !isValidTimeZone(next.quiet_timezone)) return { error: "Unknown time zone for quiet hours." };
  if (platform === "twitch") next.milestones = false;
  if (next.milestones && !current.milestones) {
    next.milestone_last = platform === "youtube" ? await seedYoutubeMilestone(sourceId) : MILESTONE_UNSEEDED;
  } else if (!next.milestones) {
    next.milestone_last = MILESTONE_UNSEEDED;
  }
  return next;
}

// ---------------------------------------------------------------------------------------------
// Create / update / delete / test
// ---------------------------------------------------------------------------------------------

const zCreateInput = z.object({
  platform: zSocialPlatform,
  sourceInput: z.string().min(1),
  discordChannelId: z.string().min(1),
  embedConfig: zSocialEmbedConfig.partial().optional(),
  messageContent: z.string().max(2000).optional(),
  mentionRoleIds: z.array(z.string()).max(10).optional(),
  options: zOptionsInput,
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
        ? `This server already tracks ${maxWatchers} creators. Remove one first.`
        : `This server already tracks ${maxWatchers} creators on the free plan. Remove one, or get Dreamliner One for up to ${ONE_WATCHERS_LIMIT}.`,
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
    const options = await mergeOptions("youtube", channel.channelId, parseSocialWatcherOptions({}), parsed.data.options);
    if ("error" in options) return { ok: false, error: options.error, status: 400 };

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
      options,
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
  const options = await mergeOptions("twitch", user.userId, parseSocialWatcherOptions({}), parsed.data.options);
  if ("error" in options) return { ok: false, error: options.error, status: 400 };

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
    options,
  });
  return { ok: true, watcher: serializeTwitchWatcher(created) };
}

const zUpdateInput = z.object({
  platform: zSocialPlatform,
  discordChannelId: z.string().min(1).optional(),
  messageContent: z.string().max(2000).optional(),
  mentionRoleIds: z.array(z.string()).max(10).optional(),
  embedConfig: zSocialEmbedConfig.optional(),
  options: zOptionsInput,
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
  const { platform, options: incomingOptions, ...patch } = parsed.data;

  if (platform === "youtube") {
    const existing = await getWatcher(guildId, id);
    if (!existing) return NOT_FOUND;
    const options = await mergeOptions("youtube", existing.sourceChannelId, existing.options, incomingOptions);
    if ("error" in options) return { ok: false, error: options.error, status: 400 };
    // Resuming a paused creator: start from their current latest upload, so whatever they posted
    // while paused isn't announced late.
    if (patch.enabled === true && !existing.enabled) {
      const latest = await fetchLatestUpload(existing.uploadsPlaylistId).catch(() => null);
      if (latest) await updateCheckpoint(existing.id, { lastVideoId: latest.videoId, lastVideoPublishedAt: latest.publishedAt });
    }
    const updated = await updateWatcher(guildId, id, { ...patch, options });
    if (!updated) return NOT_FOUND;
    return { ok: true, watcher: serializeYoutubeWatcher(updated) };
  }

  const existing = await getTwitchWatcher(guildId, id);
  if (!existing) return NOT_FOUND;
  const options = await mergeOptions("twitch", existing.sourceUserId, existing.options, incomingOptions);
  if ("error" in options) return { ok: false, error: options.error, status: 400 };
  if (patch.enabled === true && !existing.enabled) {
    // Same for Twitch: a stream already running when they're resumed doesn't notify, and a session
    // left open while paused is closed without touching its message.
    const stream = await fetchLiveStream(existing.sourceUserId).catch(() => null);
    await reseedTwitchCheckpoint(existing.id, stream);
    const open = await openTwitchSession(existing.id);
    if (open) await updateDelivery(open.id, { endedAt: new Date() });
  }
  const updated = await updateTwitchWatcher(guildId, id, { ...patch, options });
  if (!updated) return NOT_FOUND;
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
    if (!deleted) return NOT_FOUND;
    await deleteWatcherDeliveries("youtube", id).catch(() => undefined);
    return { ok: true, watcher: serializeYoutubeWatcher(deleted) };
  }
  const deleted = await deleteTwitchWatcher(guildId, id);
  if (!deleted) return NOT_FOUND;
  await deleteWatcherDeliveries("twitch", id).catch(() => undefined);
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
    if (!watcher) return NOT_FOUND;
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
  if (!watcher) return NOT_FOUND;
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

// ---------------------------------------------------------------------------------------------
// "Now showing" showcase (dashboard hero): real channels, latest uploads and live streams
// ---------------------------------------------------------------------------------------------

export type BridgeSocialShowcaseCreator = {
  /** `platform:sourceId`; a creator tracked in two channels shows once. */
  key: string;
  platform: SocialPlatform;
  watcherId: number;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  url: string;
  /** YouTube subscribers (null when hidden). Twitch doesn't expose followers to the bot. */
  followers: number | null;
  live: { title: string; url: string; thumbnailUrl: string | null; gameName: string; viewerCount: number; startedAt: string } | null;
  latest: { title: string; url: string; thumbnailUrl: string | null; publishedAt: string; kind: string } | null;
  /** YouTube: the newest few uploads (newest first). Empty for Twitch. */
  uploads: BridgeSocialShowcaseUpload[];
  /** Twitch: when they last went live, as far as Dreamliner has seen. */
  lastLiveAt: string | null;
};

export type BridgeSocialShowcaseUpload = {
  id: string;
  title: string;
  url: string;
  thumbnailUrl: string | null;
  publishedAt: string;
  durationSeconds: number | null;
  /** "video" | "short" | "live". */
  kind: string;
  live: boolean;
};

/** Creators shown in the hero (and fetched) at most, so a 50-creator server stays cheap. */
const SHOWCASE_MAX = 24;
const SHOWCASE_FRESH_MS = 10 * 60_000;
const SHOWCASE_STALE_MS = 30 * 60_000;
/** Twitch live status is free and time-sensitive, so it refreshes more often than the rest. */
const SHOWCASE_LIVE_MS = 90_000;

type ShowcaseEntry = {
  platform: SocialPlatform;
  sourceId: string;
  watcherId: number;
  lastVideoId: string | null;
  uploadsPlaylistId: string | null;
};

/** YouTube channels whose newest few uploads are fetched for the hero (1 unit each per refresh). */
const SHOWCASE_UPLOAD_CHANNELS = 12;
const SHOWCASE_UPLOADS_PER_CHANNEL = 3;

type ShowcaseBase = {
  youtube: Record<string, { channel: ChannelInfo | null; latest: VideoDetails | null; recent: VideoDetails[] }>;
  twitch: Record<string, TwitchUserInfo | null>;
};

/**
 * Per refresh (cached 10 minutes, only while someone has the page open): one playlistItems call
 * per YouTube channel for its newest few uploads (at most 12 channels), then one channels.list and
 * one videos.list call per 50 ids, so roughly N + 2 YouTube units. Twitch is one Helix call.
 */
async function loadShowcaseBase(entries: ShowcaseEntry[]): Promise<ShowcaseBase> {
  const yt = entries.filter((e) => e.platform === "youtube");
  const tw = entries.filter((e) => e.platform === "twitch");
  const recentIds = new Map<string, string[]>();
  await mapWithConcurrency(yt.slice(0, SHOWCASE_UPLOAD_CHANNELS), 4, async (e) => {
    const ids = e.uploadsPlaylistId
      ? await fetchRecentUploadIds(e.uploadsPlaylistId, SHOWCASE_UPLOADS_PER_CHANNEL).catch(() => [] as string[])
      : [];
    recentIds.set(e.sourceId, ids.length ? ids : e.lastVideoId ? [e.lastVideoId] : []);
  });
  const allIds = new Set<string>();
  for (const e of yt) {
    for (const id of recentIds.get(e.sourceId) ?? []) allIds.add(id);
    if (e.lastVideoId) allIds.add(e.lastVideoId);
  }
  const [channels, videos, users] = await Promise.all([
    yt.length ? fetchChannelsInfo(yt.map((e) => e.sourceId)).catch(() => new Map<string, ChannelInfo>()) : new Map<string, ChannelInfo>(),
    allIds.size ? fetchVideoDetails([...allIds]).catch(() => new Map<string, VideoDetails>()) : new Map<string, VideoDetails>(),
    tw.length ? fetchTwitchUsers(tw.map((e) => e.sourceId)).catch(() => new Map<string, TwitchUserInfo>()) : new Map<string, TwitchUserInfo>(),
  ]);
  const base: ShowcaseBase = { youtube: {}, twitch: {} };
  for (const e of yt) {
    const recent = (recentIds.get(e.sourceId) ?? []).map((id) => videos.get(id)).filter((v): v is VideoDetails => Boolean(v));
    base.youtube[e.sourceId] = {
      channel: channels.get(e.sourceId) ?? null,
      latest: recent[0] ?? (e.lastVideoId ? (videos.get(e.lastVideoId) ?? null) : null),
      recent,
    };
  }
  for (const e of tw) base.twitch[e.sourceId] = users.get(e.sourceId) ?? null;
  return base;
}

export async function getBridgeSocialShowcase(
  guildId: string,
): Promise<BridgeResult<{ creators: BridgeSocialShowcaseCreator[]; generatedAt: string }>> {
  const [youtubeRows, twitchRows] = await Promise.all([listWatchers(guildId), listTwitchWatchers(guildId)]);
  const seen = new Set<string>();
  const entries: ShowcaseEntry[] = [];
  const ytRows = new Map<string, SocialWatcherRow>();
  const twRows = new Map<string, SocialTwitchWatcherRow>();
  // Active creators first.
  for (const row of [...youtubeRows].sort((a, b) => Number(b.enabled) - Number(a.enabled))) {
    if (seen.has(`youtube:${row.sourceChannelId}`)) continue;
    seen.add(`youtube:${row.sourceChannelId}`);
    ytRows.set(row.sourceChannelId, row);
    entries.push({
      platform: "youtube",
      sourceId: row.sourceChannelId,
      watcherId: row.id,
      lastVideoId: row.lastVideoId,
      uploadsPlaylistId: row.uploadsPlaylistId,
    });
  }
  for (const row of [...twitchRows].sort((a, b) => Number(b.enabled) - Number(a.enabled))) {
    if (seen.has(`twitch:${row.sourceUserId}`)) continue;
    seen.add(`twitch:${row.sourceUserId}`);
    twRows.set(row.sourceUserId, row);
    entries.push({ platform: "twitch", sourceId: row.sourceUserId, watcherId: row.id, lastVideoId: row.lastStreamId, uploadsPlaylistId: null });
  }
  const picked = entries.slice(0, SHOWCASE_MAX);
  if (!picked.length) return { ok: true, creators: [], generatedAt: new Date().toISOString() };

  const hash = createHash("sha1")
    .update(picked.map((e) => `${e.platform}:${e.sourceId}:${e.lastVideoId ?? ""}`).join(","))
    .digest("hex");
  const twitchIds = picked.filter((e) => e.platform === "twitch").map((e) => e.sourceId);
  try {
    const [base, liveStreams] = await Promise.all([
      cachedSwr(`social:showcase:${guildId}:${hash}`, SHOWCASE_FRESH_MS, SHOWCASE_STALE_MS, () => loadShowcaseBase(picked)),
      twitchIds.length
        ? cached(`social:showcase-live:${createHash("sha1").update(twitchIds.join(",")).digest("hex")}`, SHOWCASE_LIVE_MS, async () =>
            Object.fromEntries(await fetchLiveStreams(twitchIds)),
          ).catch(() => ({}) as Record<string, LiveStream>)
        : Promise.resolve({} as Record<string, LiveStream>),
    ]);

    const creators: BridgeSocialShowcaseCreator[] = [];
    for (const entry of picked) {
      if (entry.platform === "youtube") {
        const row = ytRows.get(entry.sourceId)!;
        const info = base.youtube[entry.sourceId];
        const channel = info?.channel ?? null;
        const latest = info?.latest ?? null;
        // Keep stored names/avatars fresh while we have them (channels rename).
        if (channel && (channel.name !== row.sourceChannelName || channel.avatarUrl !== row.sourceChannelAvatarUrl)) {
          void refreshWatcherProfile(entry.sourceId, { name: channel.name, avatarUrl: channel.avatarUrl, handle: channel.handle }).catch(
            () => undefined,
          );
        }
        const kind = latest
          ? classifyUpload({
              liveBroadcastContent: latest.liveBroadcastContent,
              hasLiveStreamingDetails: latest.hasLiveStreamingDetails,
              durationSeconds: latest.durationSeconds,
              shortsProbe: null,
            })
          : "video";
        creators.push({
          key: `youtube:${entry.sourceId}`,
          platform: "youtube",
          watcherId: entry.watcherId,
          name: channel?.name ?? row.sourceChannelName,
          handle: channel?.handle ?? row.sourceChannelHandle,
          avatarUrl: channel?.avatarUrl ?? row.sourceChannelAvatarUrl,
          bannerUrl: channel?.bannerUrl ?? null,
          url: channel?.url ?? row.sourceChannelUrl,
          followers: channel?.subscriberCount ?? null,
          live:
            latest && latest.liveBroadcastContent === "live"
              ? {
                  title: latest.title,
                  url: latest.url,
                  thumbnailUrl: latest.thumbnailUrl,
                  gameName: "",
                  viewerCount: 0,
                  startedAt: latest.publishedAt.toISOString(),
                }
              : null,
          latest: latest
            ? {
                title: latest.title,
                url: latest.url,
                thumbnailUrl: latest.thumbnailUrl,
                publishedAt: latest.publishedAt.toISOString(),
                kind: uploadKindLabel(kind, latest.liveBroadcastContent),
              }
            : null,
          uploads: (info?.recent ?? []).map((video) => ({
            id: video.videoId,
            title: video.title,
            url: video.url,
            thumbnailUrl: video.thumbnailUrl,
            publishedAt: video.publishedAt.toISOString(),
            durationSeconds: video.durationSeconds,
            kind: classifyUpload({
              liveBroadcastContent: video.liveBroadcastContent,
              hasLiveStreamingDetails: video.hasLiveStreamingDetails,
              durationSeconds: video.durationSeconds,
              shortsProbe: null,
            }),
            live: video.liveBroadcastContent === "live",
          })),
          lastLiveAt: null,
        });
        continue;
      }

      const row = twRows.get(entry.sourceId)!;
      const user = base.twitch[entry.sourceId] ?? null;
      if (user && (user.displayName !== row.sourceUserDisplayName || user.avatarUrl !== row.sourceUserAvatarUrl)) {
        void refreshTwitchWatcherProfile(entry.sourceId, { name: user.displayName, avatarUrl: user.avatarUrl }).catch(() => undefined);
      }
      const stream = (liveStreams as Record<string, LiveStream>)[entry.sourceId];
      creators.push({
        key: `twitch:${entry.sourceId}`,
        platform: "twitch",
        watcherId: entry.watcherId,
        name: user?.displayName ?? row.sourceUserDisplayName,
        handle: `@${user?.login ?? row.sourceUserLogin}`,
        avatarUrl: user?.avatarUrl ?? row.sourceUserAvatarUrl,
        bannerUrl: user?.offlineImageUrl ?? null,
        url: user?.url ?? row.sourceUserUrl,
        followers: null,
        live: stream
          ? {
              title: stream.title,
              url: stream.url,
              // Width/height in the preview URL; a 90s bucket busts Twitch's long image cache.
              thumbnailUrl: stream.thumbnailUrl ? `${stream.thumbnailUrl.replace("1280x720", "640x360")}?t=${Math.floor(Date.now() / 90_000)}` : null,
              gameName: stream.gameName,
              viewerCount: stream.viewerCount,
              startedAt: stream.startedAt.toISOString(),
            }
          : null,
        latest: null,
        uploads: [],
        lastLiveAt: (row.lastSeenLiveAt ?? row.lastLiveAt)?.toISOString() ?? null,
      });
    }
    // Live creators first, then the rest in their stored order.
    creators.sort((a, b) => Number(Boolean(b.live)) - Number(Boolean(a.live)));
    return { ok: true, creators, generatedAt: new Date().toISOString() };
  } catch (error) {
    return resolveErrorToResult(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Twitch channel search (typeahead in the add flow). YouTube has no free search: handles and
// links are resolved on submit instead (search.list costs 100 quota units a call).
// ---------------------------------------------------------------------------------------------

export type BridgeSocialSearchResult = {
  platform: SocialPlatform;
  id: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
  isLive: boolean;
  gameName: string;
};

/** Per signed-in user, on top of the bridge's general limits: typing fires a request per pause. */
const searchLimiter = new SlidingWindowLimiter(90, 60_000);

export async function searchBridgeSocialSources(
  userId: string,
  platform: string,
  rawQuery: string,
): Promise<BridgeResult<{ results: BridgeSocialSearchResult[] }>> {
  const query = rawQuery.trim().replace(/^@/, "").slice(0, 64);
  if (platform !== "twitch" || query.length < 2) return { ok: true, results: [] };
  const limited = searchLimiter.take(userId);
  if (!limited.ok) return { ok: false, error: "Searching a lot at once. Give it a few seconds.", status: 429 };
  try {
    const channels = await cached(`social:twitch-search:${query.toLowerCase()}`, 5 * 60_000, () => searchTwitchChannels(query, 8));
    return {
      ok: true,
      results: channels.map((c) => ({
        platform: "twitch" as const,
        id: c.userId,
        login: c.login,
        displayName: c.displayName,
        avatarUrl: c.avatarUrl,
        isLive: c.isLive,
        gameName: c.gameName,
      })),
    };
  } catch (error) {
    return resolveErrorToResult(error);
  }
}
