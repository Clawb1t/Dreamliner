/**
 * Dashboard bridge for Notifications (feeds). Replaces the old /social/* routes. The contract
 * (routes, request/response shapes, error codes, catalogue entries) is documented in
 * docs/feeds-bridge.md; keep the two in sync.
 */
import type { Client, Guild } from "discord.js";
import { z } from "zod";
import {
  defaultFeedMessage,
  zFeedFilters,
  zFeedMessage,
  zFeedOptions,
  parseFeedOptions,
  type FeedFilters,
  type FeedMessage,
  type FeedOptions,
  type FeedSourceType,
} from "../config/schemas/social.js";
import { configManager } from "../config/manager.js";
import { hasPermission } from "../core/permissionRoles.js";
import { cached } from "./responseCache.js";
import { SlidingWindowLimiter } from "./rateLimit.js";
import { isDreamlinerOneActive } from "./dreamlinerOne.js";
import { getLogger } from "../core/logger.js";
import { isValidTimeZone, MILESTONE_UNSEEDED } from "../plugins/social/functions/logic.js";
import { seedYoutubeMilestone } from "../plugins/social/functions/milestoneNotify.js";
import { TwitchResolveError, searchTwitchChannels } from "../plugins/social/functions/twitch.js";
import { YoutubeResolveError, resolveYoutubeChannel } from "../plugins/social/functions/youtube.js";
import { searchSteamApps } from "../plugins/social/feeds/adapters/steam.js";
import { CATALOG_CATEGORIES, FEED_CATALOG, catalogSourceKey, getCatalogEntry } from "../plugins/social/feeds/catalog.js";
import { CATALOG_GENRES, CATALOG_PLATFORMS } from "../plugins/social/feeds/catalogTags.js";
import { catalogBanner } from "../plugins/social/feeds/banners.js";
import { FEED_TOKENS, TWITCH_TOKENS, YOUTUBE_TOKENS } from "../plugins/social/feeds/render.js";
import { deliverItem, discordSender } from "../plugins/social/feeds/deliver.js";
import { setFeedEnabled, testSendFeed } from "../plugins/social/feeds/service.js";
import {
  SourceResolveError,
  ensureSeededSource,
  previewSourceSpec,
  resolveSourceSpec,
  zFeedSourceSpec,
  type SourcePreview,
} from "../plugins/social/feeds/sources.js";
import {
  ONE_WATCHERS_LIMIT,
  FREE_WATCHERS_LIMIT,
  STATS_DAYS,
  countSubscriptions,
  feedLimitError,
  createSubscription,
  deleteSubscription,
  getSource,
  getSourceByKey,
  getSourcesByIds,
  getSubscription,
  guildFeedStats,
  latestItems,
  listSubscriptions,
  reactivateSource,
  recentGuildDeliveries,
  recentItemsWithDeliveries,
  resolveMaxWatchers,
  updateSubscription,
  type FeedSourceRow,
  type FeedSubscriptionRow,
  type FeedSubscriptionStats,
} from "../plugins/social/feeds/store.js";
const log = getLogger("bridge");

// ---------------------------------------------------------------------------------------------
// Result + errors
// ---------------------------------------------------------------------------------------------

export type FeedsErrorCode =
  | "bad_request"
  | "forbidden"
  | "not_found"
  | "limit_reached"
  | "duplicate"
  | "source_invalid"
  | "upstream_failed"
  | "rate_limited"
  | "send_failed";

export type FeedsResult<T> = ({ ok: true } & T) | { ok: false; status: number; code: FeedsErrorCode; error: string };

function fail(status: number, code: FeedsErrorCode, error: string): { ok: false; status: number; code: FeedsErrorCode; error: string } {
  return { ok: false, status, code, error };
}

function fromResolveError(error: unknown): { ok: false; status: number; code: FeedsErrorCode; error: string } {
  if (error instanceof SourceResolveError) return fail(error.status, error.status === 404 ? "not_found" : error.status === 400 ? "bad_request" : "source_invalid", error.message);
  if (error instanceof YoutubeResolveError || error instanceof TwitchResolveError) return fail(422, "source_invalid", error.message);
  log.error("[bridge] feeds lookup failed:", error);
  return fail(502, "upstream_failed", "Lookup failed. Try again shortly.");
}

const NOT_FOUND = fail(404, "not_found", "No feed with that ID in this server.");

// ---------------------------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------------------------

/** Manage Server (checked by the caller) OR the Notifications plugin's `can_manage` flag. */
export async function memberCanManageFeeds(guild: Guild, userId: string, managesServer: boolean): Promise<boolean> {
  if (managesServer) return true;
  try {
    const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId));
    const guildConfig = await configManager.getEffectiveConfig(guild.id);
    return await hasPermission(guild.id, "social", "can_manage", member, guildConfig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------------------------

export type BridgeFeedStatus = "ok" | "pending" | "failing" | "disabled" | "paused";

export type BridgeFeedSource = {
  id: number;
  type: FeedSourceType;
  key: string;
  title: string;
  iconUrl: string | null;
  siteUrl: string | null;
  catalogKey: string | null;
  region: string | null;
  official: boolean;
  /** Public bits of the source config (feed URL, Steam app id, repo, channel/user ids). */
  details: {
    url?: string;
    appId?: string;
    owner?: string;
    repo?: string;
    channelId?: string;
    handle?: string | null;
    userId?: string;
    login?: string;
  };
  intervalS: number;
  lastCheckedAt: string | null;
  lastOkAt: string | null;
  nextCheckAt: string;
  failCount: number;
  lastError: string | null;
  disabledReason: string | null;
};

export type BridgeFeed = {
  id: number;
  guildId: string;
  enabled: boolean;
  status: BridgeFeedStatus;
  channelId: string;
  mentionRoleIds: string[];
  message: FeedMessage;
  filters: FeedFilters;
  options: FeedOptions;
  deliveredCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  source: BridgeFeedSource;
  stats: FeedSubscriptionStats;
};

const EMPTY_STATS: FeedSubscriptionStats = { delivered30d: 0, deliveredAll: 0, daily: Array<number>(STATS_DAYS).fill(0), lastPostedAt: null, failed30d: 0 };

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

export function serializeSource(source: FeedSourceRow): BridgeFeedSource {
  const c = source.config;
  const s = (key: string) => (typeof c[key] === "string" ? (c[key] as string) : typeof c[key] === "number" ? String(c[key]) : undefined);
  const catalogKey = s("catalogKey") ?? null;
  const entry = catalogKey ? getCatalogEntry(catalogKey) : null;
  const details: BridgeFeedSource["details"] = {};
  if (s("url")) details.url = s("url");
  if (s("appId")) details.appId = s("appId");
  if (s("owner")) details.owner = s("owner");
  if (s("repo")) details.repo = s("repo");
  if (source.type === "youtube") {
    details.channelId = s("channelId");
    details.handle = s("handle") ?? null;
  }
  if (source.type === "twitch") {
    details.userId = s("userId");
    details.login = s("login");
  }
  return {
    id: source.id,
    type: source.type,
    key: source.key,
    title: source.title,
    iconUrl: source.iconUrl,
    siteUrl: source.siteUrl,
    catalogKey,
    region: s("region") ?? null,
    official: entry ? entry.official : true,
    details,
    intervalS: source.intervalS,
    lastCheckedAt: iso(source.lastCheckedAt),
    lastOkAt: iso(source.lastOkAt),
    nextCheckAt: source.nextCheckAt.toISOString(),
    failCount: source.failCount,
    lastError: source.lastError,
    disabledReason: source.disabledReason,
  };
}

function statusOf(subscription: FeedSubscriptionRow, source: FeedSourceRow): BridgeFeedStatus {
  if (!subscription.enabled) return "paused";
  if (source.disabledReason) return "disabled";
  if (source.failCount > 0) return "failing";
  if (!source.lastOkAt) return "pending";
  return "ok";
}

export function serializeFeed(subscription: FeedSubscriptionRow, source: FeedSourceRow, stats?: FeedSubscriptionStats): BridgeFeed {
  return {
    id: subscription.id,
    guildId: subscription.guildId,
    enabled: subscription.enabled,
    status: statusOf(subscription, source),
    channelId: subscription.channelId,
    mentionRoleIds: subscription.mentionRoleIds,
    message: subscription.message,
    filters: subscription.filters,
    options: subscription.options,
    deliveredCount: subscription.deliveredCount,
    createdBy: subscription.createdBy,
    createdAt: subscription.createdAt.toISOString(),
    updatedAt: subscription.updatedAt.toISOString(),
    source: serializeSource(source),
    stats: stats ?? { ...EMPTY_STATS, deliveredAll: subscription.deliveredCount },
  };
}

// ---------------------------------------------------------------------------------------------
// Catalogue (not per server)
// ---------------------------------------------------------------------------------------------

export type BridgeCatalogEntry = {
  key: string;
  name: string;
  group: string | null;
  category: string;
  description: string;
  type: "newswire" | "steam" | "statuspage" | "youtube";
  /** True when the publisher or creator runs the feed (verified badge); false for Rockstar and Fortnite. */
  official: boolean;
  intervalS: number;
  siteUrl: string;
  iconUrl: string;
  artUrl: string | null;
  /** Wide banner for Discover cards: the entry's own art, else its newest post's image. Null when
   *  neither exists (status pages); the site then shows a flat banner with the logo. */
  bannerUrl: string | null;
  color: number;
  regions: { value: string; label: string }[] | null;
  keywords: string[];
  genres: string[];
  platforms: string[];
  /** Position in the Featured row (1 first), or null. */
  featured: number | null;
  /** The feed source key adding it creates (match against a feed's source.key), null when it needs a region. */
  sourceKey: string | null;
};

export function getFeedCatalog() {
  const entries: BridgeCatalogEntry[] = FEED_CATALOG.map((e) => ({
    key: e.key,
    name: e.name,
    group: e.group,
    category: e.category,
    description: e.description,
    type: e.type,
    official: e.official,
    intervalS: e.intervalS,
    siteUrl: e.siteUrl,
    iconUrl: e.iconUrl,
    artUrl: e.artUrl,
    bannerUrl: catalogBanner(e),
    color: e.color,
    regions: e.regions,
    keywords: e.keywords,
    genres: e.genres,
    platforms: e.platforms,
    featured: e.featured,
    sourceKey: e.regions ? null : catalogSourceKey(e),
  }));
  const types: FeedSourceType[] = ["youtube", "twitch", "rss", "steam", "github", "statuspage", "newswire"];
  return {
    ok: true as const,
    categories: CATALOG_CATEGORIES.map((c) => ({ key: c.key, name: c.name })),
    entries,
    filters: {
      genres: Object.entries(CATALOG_GENRES).map(([key, name]) => ({ key, name })),
      platforms: Object.entries(CATALOG_PLATFORMS).map(([key, name]) => ({ key, name })),
    },
    tokens: { generic: [...FEED_TOKENS], youtube: [...YOUTUBE_TOKENS], twitch: [...TWITCH_TOKENS] },
    defaults: Object.fromEntries(types.map((t) => [t, defaultFeedMessage(t)])) as Record<FeedSourceType, FeedMessage>,
    limits: { free: FREE_WATCHERS_LIMIT, one: ONE_WATCHERS_LIMIT },
  };
}

// ---------------------------------------------------------------------------------------------
// List / get / items
// ---------------------------------------------------------------------------------------------

export type BridgeFeedDelivery = {
  id: number;
  feedId: number;
  sourceTitle: string;
  sourceType: FeedSourceType;
  sourceIconUrl: string | null;
  channelId: string;
  title: string;
  url: string;
  imageUrl: string | null;
  messageUrl: string | null;
  createdAt: string;
};

function messageUrl(guildId: string, channelId: string, messageId: string | null): string | null {
  return messageId ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}` : null;
}

export async function listBridgeFeeds(guildId: string) {
  const [subscriptions, oneActive] = await Promise.all([listSubscriptions(guildId), isDreamlinerOneActive(guildId)]);
  const sources = await getSourcesByIds(subscriptions.map((s) => s.sourceId));
  const [stats, recentRows] = await Promise.all([guildFeedStats(guildId, subscriptions), recentGuildDeliveries(guildId, 10)]);
  const feeds = subscriptions.filter((s) => sources.has(s.sourceId)).map((s) => serializeFeed(s, sources.get(s.sourceId)!, stats.get(s.id)));
  const totals = { feeds: feeds.length, delivered30d: 0, deliveredAll: 0, daily: Array<number>(STATS_DAYS).fill(0) };
  for (const feed of feeds) {
    totals.delivered30d += feed.stats.delivered30d;
    totals.deliveredAll += feed.stats.deliveredAll;
    feed.stats.daily.forEach((n, i) => (totals.daily[i] = (totals.daily[i] ?? 0) + n));
  }
  const byId = new Map(subscriptions.map((s) => [s.id, s]));
  const recent: BridgeFeedDelivery[] = [];
  for (const row of recentRows) {
    const sub = byId.get(row.subscriptionId);
    const source = sub ? sources.get(sub.sourceId) : undefined;
    if (!sub || !source) continue;
    recent.push({
      id: row.id,
      feedId: sub.id,
      sourceTitle: source.title,
      sourceType: source.type,
      sourceIconUrl: source.iconUrl,
      channelId: row.channelId,
      title: row.item?.title ?? String(row.payload.title ?? ""),
      url: row.item?.url ?? "",
      imageUrl: row.item?.imageUrl ?? null,
      messageUrl: messageUrl(guildId, row.channelId, row.messageId),
      createdAt: row.createdAt.toISOString(),
    });
  }
  return {
    ok: true as const,
    feeds,
    count: feeds.length,
    maxFeeds: resolveMaxWatchers(oneActive),
    oneActive,
    totals,
    attention: feeds.filter((f) => f.status === "failing" || f.status === "disabled").map((f) => f.id),
    recent,
    platforms: {
      youtube: Boolean(process.env.YOUTUBE_API_KEY?.trim()),
      twitch: Boolean(process.env.TWITCH_CLIENT_ID?.trim() && process.env.TWITCH_CLIENT_SECRET?.trim()),
      twitchMilestones: false,
    },
  };
}

async function loadFeed(guildId: string, id: number): Promise<{ subscription: FeedSubscriptionRow; source: FeedSourceRow } | null> {
  const subscription = await getSubscription(guildId, id);
  if (!subscription) return null;
  const source = await getSource(subscription.sourceId);
  return source ? { subscription, source } : null;
}

export async function getBridgeFeed(guildId: string, id: number): Promise<FeedsResult<{ feed: BridgeFeed }>> {
  const loaded = await loadFeed(guildId, id);
  if (!loaded) return NOT_FOUND;
  const stats = await guildFeedStats(guildId, [loaded.subscription]);
  return { ok: true, feed: serializeFeed(loaded.subscription, loaded.source, stats.get(id)) };
}

export type BridgeFeedItemStatus = "posted" | "filtered" | "failed" | "sending" | "before_feed" | "waiting";

export type BridgeFeedItem = {
  id: number;
  key: string;
  title: string;
  url: string;
  imageUrl: string | null;
  summary: string;
  author: string | null;
  tags: string[];
  publishedAt: string | null;
  firstSeenAt: string;
  status: BridgeFeedItemStatus;
  /** Why it was filtered, or the send error. */
  reason: string | null;
  messageUrl: string | null;
  postedAt: string | null;
};

export async function listBridgeFeedItems(guildId: string, id: number, limit = 20): Promise<FeedsResult<{ items: BridgeFeedItem[] }>> {
  const loaded = await loadFeed(guildId, id);
  if (!loaded) return NOT_FOUND;
  const { subscription } = loaded;
  const rows = recentItemsWithDeliveries(subscription, Math.min(50, Math.max(1, limit)));
  return {
    ok: true,
    items: rows.map(({ item, delivery }) => {
      let status: BridgeFeedItemStatus;
      if (delivery?.status === "sent" || delivery?.status === "continued") status = "posted";
      else if (delivery?.status === "filtered") status = "filtered";
      else if (delivery?.status === "failed") status = "failed";
      else if (delivery?.status === "pending") status = "sending";
      else if (item.baseline || item.id <= subscription.cursorItemId) status = "before_feed";
      else status = "waiting";
      return {
        id: item.id,
        key: item.itemKey,
        title: item.title,
        url: item.url,
        imageUrl: item.imageUrl,
        summary: item.summary,
        author: item.author,
        tags: item.tags,
        publishedAt: iso(item.publishedAt),
        firstSeenAt: item.firstSeenAt.toISOString(),
        status,
        reason: delivery?.status === "filtered" ? String(delivery.payload.reason ?? "") || null : delivery?.status === "failed" ? delivery.error : null,
        messageUrl: delivery ? messageUrl(guildId, delivery.channelId, delivery.messageId) : null,
        postedAt: delivery && (delivery.status === "sent" || delivery.status === "continued") ? delivery.createdAt.toISOString() : null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

const zSnowflake = z.string().regex(/^\d{15,25}$/);
const zMessageInput = z
  .object({
    content: z.string().max(2000).optional(),
    embed: zFeedMessage.shape.embed._def.innerType.partial().optional(),
    buttons: zFeedMessage.shape.buttons.optional(),
  })
  .optional();
const zFiltersInput = zFeedFilters.partial().optional();
const zOptionsInput = zFeedOptions.omit({ milestone_last: true }).partial().optional();

/** Merge a (partial) message over a base; null when the result isn't a valid design. */
function mergeMessage(base: FeedMessage, input: z.infer<typeof zMessageInput>): FeedMessage | null {
  if (!input) return base;
  const merged = {
    content: input.content ?? base.content,
    embed: { ...base.embed, ...(input.embed ?? {}) },
    buttons: input.buttons ?? base.buttons,
  };
  const parsed = zFeedMessage.safeParse(merged);
  return parsed.success ? parsed.data : null;
}

function mergeFilters(base: FeedFilters, input: z.infer<typeof zFiltersInput>): FeedFilters | null {
  if (!input) return base;
  const parsed = zFeedFilters.safeParse({ ...base, ...input });
  return parsed.success ? parsed.data : null;
}

/**
 * Options over the stored ones. `milestone_last` is the bot's own bookkeeping: switching
 * milestones on seeds it from the channel's current count (so old milestones never fire).
 */
async function mergeOptions(source: FeedSourceRow, current: FeedOptions, input: z.infer<typeof zOptionsInput>): Promise<FeedOptions | string> {
  if (!input) return current;
  const next = parseFeedOptions({ ...current, ...input, milestone_last: current.milestone_last });
  if (next.quiet_enabled && !isValidTimeZone(next.quiet_timezone)) return "Unknown time zone for quiet hours.";
  if (source.type !== "youtube") next.milestones = false;
  if (next.milestones && !current.milestones) {
    next.milestone_last = await seedYoutubeMilestone(String(source.config.channelId ?? ""));
  } else if (!next.milestones) {
    next.milestone_last = MILESTONE_UNSEEDED;
  }
  return next;
}

function overrideRoleIds(options: z.infer<typeof zOptionsInput>): string[] {
  return [...(options?.short_override?.role_ids ?? []), ...(options?.live_override?.role_ids ?? [])];
}

/** Every channel/role id in a request must belong to this server. */
export function feedTargets(body: Record<string, unknown>): { discordChannelId?: unknown; mentionRoleIds?: unknown } {
  const options = (body.options && typeof body.options === "object" ? body.options : {}) as z.infer<typeof zOptionsInput>;
  const roles = [...(Array.isArray(body.mentionRoleIds) ? body.mentionRoleIds : []), ...overrideRoleIds(options)];
  return {
    ...(body.channelId !== undefined ? { discordChannelId: body.channelId } : {}),
    ...(roles.length || body.mentionRoleIds !== undefined ? { mentionRoleIds: roles } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Create / update / delete / test
// ---------------------------------------------------------------------------------------------

const zCreateInput = z.object({
  source: zFeedSourceSpec,
  channelId: zSnowflake,
  mentionRoleIds: z.array(zSnowflake).max(10).optional(),
  message: zMessageInput,
  filters: zFiltersInput,
  options: zOptionsInput,
  enabled: z.boolean().optional(),
  /** Post the source's newest item right away (otherwise only new items post). */
  postLatest: z.boolean().optional(),
});
export type BridgeFeedCreateInput = z.infer<typeof zCreateInput>;

export async function createBridgeFeed(client: Client, guildId: string, actorId: string, body: unknown): Promise<FeedsResult<{ feed: BridgeFeed; seedError: string | null; postedLatest: boolean }>> {
  const parsed = zCreateInput.safeParse(body);
  if (!parsed.success) return fail(400, "bad_request", `Invalid feed: ${parsed.error.issues[0]?.path.join(".") || "body"} ${parsed.error.issues[0]?.message ?? ""}`.trim());
  const input = parsed.data;

  const [count, oneActive] = await Promise.all([countSubscriptions(guildId), isDreamlinerOneActive(guildId)]);
  const limit = feedLimitError(count, oneActive);
  if (limit) return fail(403, "limit_reached", limit);

  let resolved;
  try {
    resolved = await resolveSourceSpec(input.source);
  } catch (error) {
    return fromResolveError(error);
  }
  const sameChannel = (await listSubscriptions(guildId)).filter((s) => s.channelId === input.channelId);
  const sameChannelSources = await getSourcesByIds(sameChannel.map((s) => s.sourceId));
  if ([...sameChannelSources.values()].some((src) => src.key === resolved.input.key)) {
    return fail(409, "duplicate", "This feed already posts in that channel.");
  }

  let seeded;
  try {
    seeded = await ensureSeededSource(resolved);
  } catch (error) {
    return fromResolveError(error);
  }
  const { source, seedError } = seeded;

  const entry = typeof source.config.catalogKey === "string" ? getCatalogEntry(source.config.catalogKey) : null;
  const message = mergeMessage(defaultFeedMessage(source.type, entry?.color), input.message);
  if (!message) return fail(400, "bad_request", "Invalid message design.");
  const filters = mergeFilters(zFeedFilters.parse({}), input.filters);
  if (!filters) return fail(400, "bad_request", "Invalid filters.");
  const options = await mergeOptions(source, parseFeedOptions({}), input.options);
  if (typeof options === "string") return fail(400, "bad_request", options);

  const subscription = await createSubscription({
    guildId,
    sourceId: source.id,
    channelId: input.channelId,
    message,
    mentionRoleIds: input.mentionRoleIds ?? [],
    filters,
    options,
    createdBy: actorId,
    enabled: input.enabled ?? true,
  });

  let postedLatest = false;
  if (input.postLatest && subscription.enabled && source.type !== "twitch") {
    const newest = latestItems(source.id, 1)[0];
    if (newest) postedLatest = (await deliverItem(subscription, source, newest, discordSender(client))) === "sent";
  }
  const fresh = (await getSubscription(guildId, subscription.id)) ?? subscription;
  return { ok: true, feed: serializeFeed(fresh, (await getSource(source.id)) ?? source), seedError, postedLatest };
}

const zUpdateInput = z.object({
  channelId: zSnowflake.optional(),
  mentionRoleIds: z.array(zSnowflake).max(10).optional(),
  message: zMessageInput,
  filters: zFiltersInput,
  options: zOptionsInput,
  enabled: z.boolean().optional(),
  /** Clear a disabled/failing source's error and check it again now. */
  retry: z.boolean().optional(),
});
export type BridgeFeedUpdateInput = z.infer<typeof zUpdateInput>;

export async function updateBridgeFeed(guildId: string, id: number, body: unknown): Promise<FeedsResult<{ feed: BridgeFeed }>> {
  const parsed = zUpdateInput.safeParse(body);
  if (!parsed.success) return fail(400, "bad_request", `Invalid update: ${parsed.error.issues[0]?.path.join(".") || "body"} ${parsed.error.issues[0]?.message ?? ""}`.trim());
  const input = parsed.data;
  const loaded = await loadFeed(guildId, id);
  if (!loaded) return NOT_FOUND;
  const { subscription, source } = loaded;

  const message = mergeMessage(subscription.message, input.message);
  if (!message) return fail(400, "bad_request", "Invalid message design.");
  const filters = mergeFilters(subscription.filters, input.filters);
  if (!filters) return fail(400, "bad_request", "Invalid filters.");
  const options = await mergeOptions(source, subscription.options, input.options);
  if (typeof options === "string") return fail(400, "bad_request", options);

  if (input.retry) await reactivateSource(source.id);
  if (input.enabled !== undefined && input.enabled !== subscription.enabled) await setFeedEnabled(guildId, id, input.enabled);
  const updated = await updateSubscription(guildId, id, {
    ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
    ...(input.mentionRoleIds !== undefined ? { mentionRoleIds: input.mentionRoleIds } : {}),
    message,
    filters,
    options,
  });
  if (!updated) return NOT_FOUND;
  const stats = await guildFeedStats(guildId, [updated]);
  return { ok: true, feed: serializeFeed(updated, (await getSource(source.id)) ?? source, stats.get(id)) };
}

export async function deleteBridgeFeed(guildId: string, id: number): Promise<FeedsResult<{ feed: BridgeFeed }>> {
  const loaded = await loadFeed(guildId, id);
  if (!loaded) return NOT_FOUND;
  const deleted = await deleteSubscription(guildId, id);
  if (!deleted) return NOT_FOUND;
  return { ok: true, feed: serializeFeed(deleted, loaded.source) };
}

export async function testBridgeFeed(client: Client, guildId: string, id: number): Promise<FeedsResult<{ sent: true; messageId: string; channelId: string; messageUrl: string }>> {
  const result = await testSendFeed(client, guildId, id);
  if (!result.ok) return fail(result.status, result.status === 404 ? "not_found" : "send_failed", result.error);
  return { ok: true, sent: true, messageId: result.messageId, channelId: result.channelId, messageUrl: messageUrl(guildId, result.channelId, result.messageId)! };
}

// ---------------------------------------------------------------------------------------------
// Bulk
// ---------------------------------------------------------------------------------------------

const zBulkInput = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(50),
  set: z
    .object({
      channelId: zSnowflake.optional(),
      mentionRoleIds: z.array(zSnowflake).max(10).optional(),
      enabled: z.boolean().optional(),
      options: zFeedOptions.pick({ quiet_enabled: true, quiet_start: true, quiet_end: true, quiet_timezone: true, cooldown_minutes: true }).partial().optional(),
    })
    .refine((s) => Object.keys(s).length > 0, "Nothing to change."),
});
export type BridgeFeedBulkInput = z.infer<typeof zBulkInput>;

export async function bulkBridgeFeeds(guildId: string, body: unknown): Promise<FeedsResult<{ feeds: BridgeFeed[]; missing: number[] }>> {
  const parsed = zBulkInput.safeParse(body);
  if (!parsed.success) return fail(400, "bad_request", `Invalid bulk change: ${parsed.error.issues[0]?.message ?? "body"}`);
  const { ids, set } = parsed.data;
  if (set.options?.quiet_timezone && !isValidTimeZone(set.options.quiet_timezone)) return fail(400, "bad_request", "Unknown time zone for quiet hours.");
  const feeds: BridgeFeed[] = [];
  const missing: number[] = [];
  for (const id of [...new Set(ids)]) {
    const loaded = await loadFeed(guildId, id);
    if (!loaded) {
      missing.push(id);
      continue;
    }
    if (set.enabled !== undefined && set.enabled !== loaded.subscription.enabled) await setFeedEnabled(guildId, id, set.enabled);
    const updated = await updateSubscription(guildId, id, {
      ...(set.channelId !== undefined ? { channelId: set.channelId } : {}),
      ...(set.mentionRoleIds !== undefined ? { mentionRoleIds: set.mentionRoleIds } : {}),
      ...(set.options ? { options: parseFeedOptions({ ...loaded.subscription.options, ...set.options }) } : {}),
    });
    if (updated) feeds.push(serializeFeed(updated, loaded.source));
  }
  return { ok: true, feeds, missing };
}

// ---------------------------------------------------------------------------------------------
// Discovery: preview + search
// ---------------------------------------------------------------------------------------------

/** Per signed-in user, on top of the bridge's general read bucket: previews fetch other sites. */
const previewLimiter = new SlidingWindowLimiter(30, 60_000);
/** Typing in a search box fires a request per pause. */
const searchLimiter = new SlidingWindowLimiter(90, 60_000);

export type BridgeFeedPreview = Omit<SourcePreview, "items"> & {
  items: { key: string; title: string; url: string; imageUrl: string | null; summary: string; author: string | null; tags: string[]; publishedAt: string | null }[];
  /** Run by the publisher or creator (false for the Rockstar Newswire and Fortnite news). */
  official: boolean;
};

export async function previewBridgeFeed(userId: string, body: unknown): Promise<FeedsResult<{ preview: BridgeFeedPreview }>> {
  const parsed = z.object({ source: zFeedSourceSpec }).safeParse(body);
  if (!parsed.success) return fail(400, "bad_request", "source is required.");
  if (!previewLimiter.take(userId).ok) return fail(429, "rate_limited", "Previewing a lot at once. Give it a few seconds.");
  try {
    const resolved = await resolveSourceSpec(parsed.data.source);
    const existing = await getSourceByKey(resolved.input.key);
    const preview = await previewSourceSpec(parsed.data.source, existing);
    const entry = "catalogKey" in parsed.data.source ? getCatalogEntry(parsed.data.source.catalogKey) : null;
    return {
      ok: true,
      preview: {
        ...preview,
        official: entry ? entry.official : true,
        items: preview.items.map((i) => ({ ...i, publishedAt: i.publishedAt ? i.publishedAt.toISOString() : null })),
      },
    };
  } catch (error) {
    return fromResolveError(error);
  }
}

export type BridgeFeedSearchResult = {
  type: "steam" | "youtube" | "twitch";
  /** Pass as the source spec: steam -> { type: "steam", appId: id }, youtube/twitch -> { type, input: id }. */
  id: string;
  name: string;
  handle: string | null;
  imageUrl: string | null;
  url: string;
  live: boolean;
  detail: string | null;
};

export async function searchBridgeFeeds(userId: string, type: string, rawQuery: string): Promise<FeedsResult<{ results: BridgeFeedSearchResult[] }>> {
  const query = rawQuery.trim().replace(/^@/, "").slice(0, 80);
  if (type !== "steam" && type !== "youtube" && type !== "twitch") return fail(400, "bad_request", "type must be steam, youtube or twitch.");
  if (query.length < 2) return { ok: true, results: [] };
  if (!searchLimiter.take(userId).ok) return fail(429, "rate_limited", "Searching a lot at once. Give it a few seconds.");
  try {
    if (type === "steam") {
      const apps = await cached(`feeds:steam-search:${query.toLowerCase()}`, 10 * 60_000, () => searchSteamApps(query, 8));
      return {
        ok: true,
        results: apps.map((a) => ({ type: "steam" as const, id: a.appId, name: a.name, handle: null, imageUrl: a.imageUrl, url: `https://store.steampowered.com/app/${a.appId}/`, live: false, detail: `App ${a.appId}` })),
      };
    }
    if (type === "twitch") {
      const channels = await cached(`feeds:twitch-search:${query.toLowerCase()}`, 5 * 60_000, () => searchTwitchChannels(query, 8));
      return {
        ok: true,
        results: channels.map((c) => ({ type: "twitch" as const, id: c.login, name: c.displayName, handle: `@${c.login}`, imageUrl: c.avatarUrl, url: `https://www.twitch.tv/${c.login}`, live: c.isLive, detail: c.gameName || null })),
      };
    }
    // YouTube has no free search (search.list costs 100 units): a handle, link or id is resolved instead.
    const channel = await cached(`feeds:yt:${query.toLowerCase()}`, 10 * 60_000, () => resolveYoutubeChannel(query)).catch((error: unknown) => {
      if (error instanceof YoutubeResolveError) return null;
      throw error;
    });
    return {
      ok: true,
      results: channel
        ? [{ type: "youtube" as const, id: channel.channelId, name: channel.name, handle: channel.handle, imageUrl: channel.avatarUrl, url: channel.url, live: false, detail: channel.subscriberCount !== null ? `${channel.subscriberCount.toLocaleString("en-US")} subscribers` : null }]
        : [],
    };
  } catch (error) {
    return fromResolveError(error);
  }
}
