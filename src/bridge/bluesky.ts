import { createHash } from "node:crypto";
import type { Client } from "discord.js";
import { z } from "zod";
import {
  DEFAULT_BLUESKY_MESSAGE,
  validateBlueskyFeedOptions,
  zBlueskyFeedOptions,
  type BlueskyFeedOptions,
} from "../config/schemas/bluesky.js";
import {
  BlueskyResolveError,
  getAuthorFeed,
  getLatestPost,
  getProfilesBatched,
  parseAtUri,
  resolveActor,
  resolveCollection,
  searchActorsTypeahead,
  type BlueskyPost,
  type BlueskyProfile,
} from "../plugins/bluesky/functions/api.js";
import { MILESTONE_UNSEEDED, milestoneAtOrBelow } from "../plugins/bluesky/functions/milestones.js";
import { seedMilestone } from "../plugins/bluesky/functions/milestoneNotify.js";
import { getAccount } from "../plugins/bluesky/functions/accounts.js";
import { deliverPost } from "../plugins/bluesky/functions/notify.js";
import {
  BlueskyOauthError,
  NOT_CONFIGURED_MESSAGE,
  completeCallback,
  disconnect,
  getPublicOauthDocuments,
  isBlueskyOauthConfigured,
  startAuthorize,
} from "../plugins/bluesky/functions/oauth.js";
import {
  ONE_FEEDS_LIMIT,
  countFeeds,
  createFeed,
  deleteFeed,
  getFeed,
  guildFeedStats,
  listFeeds,
  recentGuildDeliveries,
  refreshFeedProfile,
  resolveMaxFeeds,
  STATS_DAYS,
  updateFeed,
  type BlueskyFeedRow,
  type BlueskyFeedStats,
} from "../plugins/bluesky/functions/store.js";
import { mapWithConcurrency } from "../core/concurrency.js";
import { cached, cachedSwr } from "./responseCache.js";
import { SlidingWindowLimiter } from "./rateLimit.js";
import { refreshStreamSubscription } from "../plugins/bluesky/functions/stream.js";
import { isDreamlinerOneActive } from "./dreamlinerOne.js";
import { getLogger } from "../core/logger.js";
const log = getLogger("bridge");

type BridgeResult<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };

export type BridgeBlueskyFeed = {
  id: number;
  guildId: string;
  discordChannelId: string;
  did: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  profileUrl: string;
  messageContent: string;
  mentionRoleIds: string[];
  options: BlueskyFeedOptions;
  lastPostAt: string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type BridgeBlueskyProfile = Pick<
  BlueskyProfile,
  "did" | "handle" | "displayName" | "avatarUrl" | "url" | "description" | "followersCount" | "postsCount"
>;

function serializeFeed(row: BlueskyFeedRow): BridgeBlueskyFeed {
  return {
    id: row.id,
    guildId: row.guildId,
    discordChannelId: row.discordChannelId,
    did: row.did,
    handle: row.handle,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    profileUrl: `https://bsky.app/profile/${row.handle}`,
    messageContent: row.messageContent,
    mentionRoleIds: row.mentionRoleIds,
    options: row.options,
    lastPostAt: row.lastPostAt ? row.lastPostAt.toISOString() : null,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeProfile(profile: BlueskyProfile): BridgeBlueskyProfile {
  const { did, handle, displayName, avatarUrl, url, description, followersCount, postsCount } = profile;
  return { did, handle, displayName, avatarUrl, url, description, followersCount, postsCount };
}

function lookupError(error: unknown): { ok: false; error: string; status: number } {
  if (error instanceof BlueskyResolveError) return { ok: false, error: error.message, status: 422 };
  log.error("[bridge] bluesky lookup error:", error);
  return { ok: false, error: "Couldn't reach Bluesky. Try again shortly.", status: 502 };
}

const NOT_FOUND = { ok: false as const, error: "No Bluesky feed with that ID.", status: 404 };

// ---------------------------------------------------------------------------------------------
// Guild feeds
// ---------------------------------------------------------------------------------------------

export type BridgeBlueskyFeedStats = BlueskyFeedStats & { lastPostAt: string | null };

export type BridgeBlueskyTotals = {
  accounts: number;
  delivered30d: number;
  deliveredAll: number;
  likes: number;
  reposts: number;
  daily: number[];
};

export type BridgeBlueskyDelivery = {
  id: number;
  feedId: number;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  channelId: string;
  messageUrl: string | null;
  postUrl: string;
  likes: number;
  reposts: number;
  createdAt: string;
};

function postUrlFor(postUri: string, handle: string): string {
  const parsed = parseAtUri(postUri);
  return parsed ? `https://bsky.app/profile/${parsed.did}/post/${parsed.rkey}` : `https://bsky.app/profile/${handle}`;
}

export async function listBridgeBlueskyFeeds(guildId: string): Promise<
  BridgeResult<{
    feeds: BridgeBlueskyFeed[];
    count: number;
    maxFeeds: number;
    accountsEnabled: boolean;
    stats: Record<string, BridgeBlueskyFeedStats>;
    totals: BridgeBlueskyTotals;
    recent: BridgeBlueskyDelivery[];
  }>
> {
  // Like Social Notifications, managing feeds works whether or not the plugin is on; the plugin's
  // enabled flag only gates whether posts are actually delivered (see stream.ts).
  const [rows, oneActive] = await Promise.all([listFeeds(guildId), isDreamlinerOneActive(guildId)]);
  const [statsById, recentRows] = await Promise.all([guildFeedStats(guildId, rows), recentGuildDeliveries(guildId, 8)]);

  const stats: Record<string, BridgeBlueskyFeedStats> = {};
  const totals: BridgeBlueskyTotals = {
    accounts: new Set(rows.map((row) => row.did)).size,
    delivered30d: 0,
    deliveredAll: 0,
    likes: 0,
    reposts: 0,
    daily: Array<number>(STATS_DAYS).fill(0),
  };
  for (const row of rows) {
    const entry = statsById.get(row.id);
    if (!entry) continue;
    stats[String(row.id)] = { ...entry, lastPostAt: row.lastPostAt ? row.lastPostAt.toISOString() : null };
    totals.delivered30d += entry.delivered30d;
    totals.deliveredAll += entry.deliveredAll;
    totals.likes += entry.likes;
    totals.reposts += entry.reposts;
    entry.daily.forEach((n, i) => {
      totals.daily[i] = (totals.daily[i] ?? 0) + n;
    });
  }

  const feedsById = new Map(rows.map((row) => [row.id, row]));
  const recent: BridgeBlueskyDelivery[] = [];
  for (const delivery of recentRows) {
    const feed = delivery.feedId !== null ? feedsById.get(delivery.feedId) : undefined;
    if (!feed) continue;
    recent.push({
      id: delivery.id,
      feedId: feed.id,
      handle: feed.handle,
      displayName: feed.displayName || feed.handle,
      avatarUrl: feed.avatarUrl,
      channelId: delivery.channelId,
      messageUrl: delivery.messageId ? `https://discord.com/channels/${guildId}/${delivery.channelId}/${delivery.messageId}` : null,
      postUrl: postUrlFor(delivery.postUri, feed.handle),
      likes: delivery.likeCount,
      reposts: delivery.repostCount,
      createdAt: delivery.createdAt.toISOString(),
    });
  }

  return {
    ok: true,
    feeds: rows.map(serializeFeed),
    count: rows.length,
    maxFeeds: resolveMaxFeeds(oneActive),
    accountsEnabled: isBlueskyOauthConfigured(),
    stats,
    totals,
    recent,
  };
}

export async function resolveBridgeBlueskyProfile(input: string): Promise<BridgeResult<{ profile: BridgeBlueskyProfile }>> {
  try {
    return { ok: true, profile: serializeProfile(await resolveActor(input)) };
  } catch (error) {
    return lookupError(error);
  }
}

const zRoleIds = z.array(z.string().regex(/^\d{5,25}$/)).max(10);

const zCreateInput = z.object({
  sourceInput: z.string().min(1).max(300),
  discordChannelId: z.string().regex(/^\d{5,25}$/),
  messageContent: z.string().max(2000).optional(),
  mentionRoleIds: zRoleIds.optional(),
  options: zBlueskyFeedOptions.partial().optional(),
});

export async function createBridgeBlueskyFeed(
  guildId: string,
  actorId: string,
  input: unknown,
): Promise<BridgeResult<{ feed: BridgeBlueskyFeed }>> {
  const parsed = zCreateInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "sourceInput and discordChannelId are required.", status: 400 };

  const [count, oneActive] = await Promise.all([countFeeds(guildId), isDreamlinerOneActive(guildId)]);
  const maxFeeds = resolveMaxFeeds(oneActive);
  if (count >= maxFeeds) {
    return {
      ok: false,
      error: oneActive
        ? `This server already follows ${maxFeeds} Bluesky accounts. Remove one first.`
        : `This server already follows ${maxFeeds} Bluesky accounts on the free plan. Remove one, or get Dreamliner One for up to ${ONE_FEEDS_LIMIT}.`,
      status: 400,
    };
  }

  let profile: BlueskyProfile;
  try {
    profile = await resolveActor(parsed.data.sourceInput);
  } catch (error) {
    return lookupError(error);
  }

  const options = validateBlueskyFeedOptions(parsed.data.options ?? {});
  options.milestone_last = options.follower_milestones ? milestoneAtOrBelow(profile.followersCount) : MILESTONE_UNSEEDED;
  const created = await createFeed({
    guildId,
    discordChannelId: parsed.data.discordChannelId,
    did: profile.did,
    handle: profile.handle,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    messageContent: parsed.data.messageContent ?? DEFAULT_BLUESKY_MESSAGE,
    mentionRoleIds: parsed.data.mentionRoleIds ?? [],
    options,
    createdBy: actorId,
  });
  refreshStreamSubscription();
  return { ok: true, feed: serializeFeed(created) };
}

const zUpdateInput = z.object({
  discordChannelId: z.string().regex(/^\d{5,25}$/).optional(),
  messageContent: z.string().max(2000).optional(),
  mentionRoleIds: zRoleIds.optional(),
  options: zBlueskyFeedOptions.optional(),
  enabled: z.boolean().optional(),
});

export async function updateBridgeBlueskyFeed(
  guildId: string,
  id: number,
  input: unknown,
): Promise<BridgeResult<{ feed: BridgeBlueskyFeed }>> {
  const parsed = zUpdateInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid update payload.", status: 400 };
  const patch = { ...parsed.data };
  if (patch.options) {
    // `milestone_last` is the bot's own bookkeeping, never taken from the dashboard. Turning
    // milestones on records the account's current milestone so old ones aren't announced.
    const existing = await getFeed(guildId, id);
    if (!existing) return NOT_FOUND;
    const wasOn = existing.options.follower_milestones;
    const nowOn = patch.options.follower_milestones;
    patch.options = {
      ...patch.options,
      milestone_last: !nowOn ? MILESTONE_UNSEEDED : wasOn ? existing.options.milestone_last : await seedMilestone(existing.did),
    };
  }
  const updated = await updateFeed(guildId, id, patch);
  if (!updated) return NOT_FOUND;
  if (parsed.data.enabled !== undefined || parsed.data.options !== undefined) refreshStreamSubscription();
  return { ok: true, feed: serializeFeed(updated) };
}

export async function deleteBridgeBlueskyFeed(guildId: string, id: number): Promise<BridgeResult<{ feed: BridgeBlueskyFeed }>> {
  const deleted = await deleteFeed(guildId, id);
  if (!deleted) return NOT_FOUND;
  refreshStreamSubscription();
  return { ok: true, feed: serializeFeed(deleted) };
}

/** Posts the account's latest post with this feed's settings, without touching real deliveries. */
export async function testSendBridgeBlueskyFeed(client: Client, guildId: string, id: number): Promise<BridgeResult<{ sent: true }>> {
  const feed = await getFeed(guildId, id);
  if (!feed) return NOT_FOUND;
  let post;
  let creator: BlueskyProfile;
  try {
    [post, creator] = await Promise.all([getLatestPost(feed.did), resolveActor(feed.did)]);
  } catch (error) {
    return lookupError(error);
  }
  if (!post) return { ok: false, error: `@${feed.handle} hasn't posted anything yet, so there's nothing to test with.`, status: 422 };
  const sent = await deliverPost(client, { feed, post, kind: post.kind, creator, test: true });
  if (!sent) return { ok: false, error: "Couldn't send to that channel. Check the bot's permissions there.", status: 502 };
  return { ok: true, sent: true };
}

// ---------------------------------------------------------------------------------------------
// "Your sky" showcase (dashboard hero): real profiles and recent posts of the followed accounts
// ---------------------------------------------------------------------------------------------

export type BridgeBlueskyShowcasePost = {
  uri: string;
  url: string;
  text: string;
  images: { url: string; alt: string }[];
  likeCount: number;
  repostCount: number;
  createdAt: string;
};

export type BridgeBlueskyShowcaseAccount = {
  did: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  description: string;
  followersCount: number;
  postsCount: number;
  url: string;
  posts: BridgeBlueskyShowcasePost[];
};

/** Accounts shown in the hero (and fetched from Bluesky) at most, so a 50-feed server stays cheap. */
const SHOWCASE_MAX_ACCOUNTS = 24;
const SHOWCASE_POSTS_PER_ACCOUNT = 3;
const SHOWCASE_FRESH_MS = 10 * 60_000;
const SHOWCASE_STALE_MS = 30 * 60_000;
const SHOWCASE_CONCURRENCY = 4;

function showcasePost(post: BlueskyPost): BridgeBlueskyShowcasePost {
  const images = post.images.length
    ? post.images.slice(0, 2).map((img) => ({ url: img.thumbUrl ?? img.url, alt: img.alt }))
    : post.videoThumbnailUrl
      ? [{ url: post.videoThumbnailUrl, alt: "" }]
      : post.external?.thumbUrl
        ? [{ url: post.external.thumbUrl, alt: post.external.title }]
        : [];
  const text = post.text.trim();
  return {
    uri: post.uri,
    url: post.url,
    text: text.length > 280 ? `${text.slice(0, 279).trimEnd()}…` : text,
    images,
    likeCount: post.likeCount,
    repostCount: post.repostCount,
    createdAt: post.createdAt.toISOString(),
  };
}

async function loadShowcase(dids: string[], stored: Map<string, BlueskyFeedRow>): Promise<BridgeBlueskyShowcaseAccount[]> {
  const profiles = new Map((await getProfilesBatched(dids)).map((profile) => [profile.did, profile]));
  const accounts = await mapWithConcurrency(dids, SHOWCASE_CONCURRENCY, async (did) => {
    const profile = profiles.get(did);
    if (!profile) return null;
    // Stored names/avatars only refresh when the account posts; catch handle changes here too.
    const row = stored.get(did);
    if (row && (row.handle !== profile.handle || row.displayName !== profile.displayName || row.avatarUrl !== profile.avatarUrl)) {
      await refreshFeedProfile(did, profile).catch(() => undefined);
    }
    const posts = await getAuthorFeed(did, SHOWCASE_POSTS_PER_ACCOUNT).catch(() => [] as BlueskyPost[]);
    return {
      did: profile.did,
      handle: profile.handle,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      bannerUrl: profile.bannerUrl,
      description: profile.description.slice(0, 300),
      followersCount: profile.followersCount,
      postsCount: profile.postsCount,
      url: profile.url,
      posts: posts.map(showcasePost),
    } satisfies BridgeBlueskyShowcaseAccount;
  });
  return accounts.filter((account): account is BridgeBlueskyShowcaseAccount => account !== null);
}

export async function getBridgeBlueskyShowcase(
  guildId: string,
): Promise<BridgeResult<{ accounts: BridgeBlueskyShowcaseAccount[]; generatedAt: string }>> {
  const rows = await listFeeds(guildId);
  // Live accounts first, then whoever posted most recently.
  const ordered = [...rows].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || (b.lastPostAt?.getTime() ?? 0) - (a.lastPostAt?.getTime() ?? 0),
  );
  const stored = new Map<string, BlueskyFeedRow>();
  for (const row of ordered) if (!stored.has(row.did)) stored.set(row.did, row);
  const dids = [...stored.keys()].slice(0, SHOWCASE_MAX_ACCOUNTS);
  if (!dids.length) return { ok: true, accounts: [], generatedAt: new Date().toISOString() };

  // The key carries the account list, so following someone new shows up right away.
  const key = `bluesky:showcase:${guildId}:${createHash("sha1").update(dids.join(",")).digest("hex")}`;
  try {
    const accounts = await cachedSwr(key, SHOWCASE_FRESH_MS, SHOWCASE_STALE_MS, () => loadShowcase(dids, stored));
    return { ok: true, accounts, generatedAt: new Date().toISOString() };
  } catch (error) {
    return lookupError(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Account search (typeahead in the Follow account flow)
// ---------------------------------------------------------------------------------------------

export type BridgeBlueskySearchActor = { did: string; handle: string; displayName: string; avatarUrl: string | null };

/** Per signed-in user, on top of the bridge's general limits: typing fires a request per pause. */
const searchLimiter = new SlidingWindowLimiter(90, 60_000);

export async function searchBridgeBlueskyActors(
  userId: string,
  rawQuery: string,
): Promise<BridgeResult<{ actors: BridgeBlueskySearchActor[] }>> {
  const query = rawQuery.trim().replace(/^@/, "").slice(0, 64);
  if (query.length < 2) return { ok: true, actors: [] };
  const limited = searchLimiter.take(userId);
  if (!limited.ok) return { ok: false, error: "Searching a lot at once. Give it a few seconds.", status: 429 };
  try {
    const actors = await cached(`bluesky:typeahead:${query.toLowerCase()}`, 5 * 60_000, () => searchActorsTypeahead(query, 8));
    return {
      ok: true,
      actors: actors.map(({ did, handle, displayName, avatarUrl }) => ({ did, handle, displayName, avatarUrl })),
    };
  } catch (error) {
    return lookupError(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Import from a list or starter pack
// ---------------------------------------------------------------------------------------------

/** Members read from one list or starter pack at most (above the Dreamliner One feed cap on purpose). */
const IMPORT_MEMBER_CAP = 150;

export type BridgeBlueskyImportPreview = {
  source: {
    kind: "list" | "starter_pack";
    name: string;
    description: string;
    url: string;
    avatarUrl: string | null;
    creator: { handle: string; displayName: string; avatarUrl: string | null };
    total: number;
    truncated: boolean;
  };
  accounts: (BridgeBlueskySearchActor & { alreadyFollowed: boolean })[];
  slotsLeft: number;
  maxFeeds: number;
};

const zImportPreviewInput = z.object({ url: z.string().trim().min(1).max(500) });

export async function previewBridgeBlueskyImport(guildId: string, input: unknown): Promise<BridgeResult<BridgeBlueskyImportPreview>> {
  const parsed = zImportPreviewInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Paste a Bluesky list or starter pack link.", status: 400 };

  let collection;
  try {
    collection = await cached(`bluesky:collection:${parsed.data.url}`, 2 * 60_000, () =>
      resolveCollection(parsed.data.url, IMPORT_MEMBER_CAP),
    );
  } catch (error) {
    return lookupError(error);
  }
  const [rows, oneActive] = await Promise.all([listFeeds(guildId), isDreamlinerOneActive(guildId)]);
  const maxFeeds = resolveMaxFeeds(oneActive);
  const followed = new Set(rows.map((row) => row.did));
  return {
    ok: true,
    source: {
      kind: collection.kind,
      name: collection.name,
      description: collection.description.slice(0, 500),
      url: collection.url,
      avatarUrl: collection.avatarUrl,
      creator: {
        handle: collection.creator.handle,
        displayName: collection.creator.displayName,
        avatarUrl: collection.creator.avatarUrl,
      },
      total: collection.total,
      truncated: collection.truncated,
    },
    accounts: collection.members.map((member) => ({
      did: member.did,
      handle: member.handle,
      displayName: member.displayName,
      avatarUrl: member.avatarUrl,
      alreadyFollowed: followed.has(member.did),
    })),
    slotsLeft: Math.max(0, maxFeeds - rows.length),
    maxFeeds,
  };
}

const zImportInput = z.object({
  dids: z
    .array(z.string().regex(/^did:(plc|web):[A-Za-z0-9._:%-]+$/))
    .min(1)
    .max(IMPORT_MEMBER_CAP),
  discordChannelId: z.string().regex(/^\d{5,25}$/),
  messageContent: z.string().max(2000).optional(),
  mentionRoleIds: zRoleIds.optional(),
  options: zBlueskyFeedOptions.partial().optional(),
});

export type BridgeBlueskyImportResult = {
  created: BridgeBlueskyFeed[];
  skipped: { alreadyFollowed: number; overLimit: number; notFound: number };
};

/** Adds every picked account to one channel with shared settings, within the plan's feed limit. */
export async function importBridgeBlueskyFeeds(
  guildId: string,
  actorId: string,
  input: unknown,
): Promise<BridgeResult<BridgeBlueskyImportResult>> {
  const parsed = zImportInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Pick at least one account and a channel.", status: 400 };

  const [rows, oneActive] = await Promise.all([listFeeds(guildId), isDreamlinerOneActive(guildId)]);
  const maxFeeds = resolveMaxFeeds(oneActive);
  const followed = new Set(rows.map((row) => row.did));
  const picked = [...new Set(parsed.data.dids)];
  const wanted = picked.filter((did) => !followed.has(did));
  const slots = Math.max(0, maxFeeds - rows.length);
  const toAdd = wanted.slice(0, slots);
  const skipped = { alreadyFollowed: picked.length - wanted.length, overLimit: wanted.length - toAdd.length, notFound: 0 };

  if (!toAdd.length) {
    if (skipped.overLimit > 0) {
      return {
        ok: false,
        error: oneActive
          ? `This server already follows ${maxFeeds} Bluesky accounts. Remove some first.`
          : `This server already follows ${maxFeeds} Bluesky accounts on the free plan. Remove some, or get Dreamliner One for up to ${ONE_FEEDS_LIMIT}.`,
        status: 400,
      };
    }
    return { ok: true, created: [], skipped };
  }

  let profiles: BlueskyProfile[];
  try {
    profiles = await getProfilesBatched(toAdd);
  } catch (error) {
    return lookupError(error);
  }
  const byDid = new Map(profiles.map((profile) => [profile.did, profile]));
  const baseOptions = validateBlueskyFeedOptions(parsed.data.options ?? {});
  const created: BridgeBlueskyFeed[] = [];
  for (const did of toAdd) {
    const profile = byDid.get(did);
    if (!profile) {
      skipped.notFound += 1;
      continue;
    }
    const row = await createFeed({
      guildId,
      discordChannelId: parsed.data.discordChannelId,
      did: profile.did,
      handle: profile.handle,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      messageContent: parsed.data.messageContent ?? DEFAULT_BLUESKY_MESSAGE,
      mentionRoleIds: parsed.data.mentionRoleIds ?? [],
      options: {
        ...baseOptions,
        milestone_last: baseOptions.follower_milestones ? milestoneAtOrBelow(profile.followersCount) : MILESTONE_UNSEEDED,
      },
      createdBy: actorId,
    });
    created.push(serializeFeed(row));
  }
  if (created.length) refreshStreamSubscription();
  return { ok: true, created, skipped };
}

// ---------------------------------------------------------------------------------------------
// Member account connection
// ---------------------------------------------------------------------------------------------

export type BridgeBlueskyAccount = { did: string; handle: string; displayName: string; avatarUrl: string | null; connectedAt: string };

export async function getBridgeBlueskyAccount(
  discordUserId: string,
): Promise<{ ok: true; enabled: boolean; account: BridgeBlueskyAccount | null }> {
  const account = await getAccount(discordUserId);
  return {
    ok: true,
    enabled: isBlueskyOauthConfigured(),
    account: account
      ? {
          did: account.did,
          handle: account.handle,
          displayName: account.displayName,
          avatarUrl: account.avatarUrl,
          connectedAt: account.createdAt.toISOString(),
        }
      : null,
  };
}

function oauthError(error: unknown): { ok: false; error: string; status: number } {
  if (error instanceof BlueskyOauthError) {
    return { ok: false, error: error.message, status: error.message === NOT_CONFIGURED_MESSAGE ? 503 : 400 };
  }
  log.error("[bridge] bluesky oauth error:", error);
  return { ok: false, error: "Something went wrong talking to Bluesky. Please try again.", status: 502 };
}

export async function startBridgeBlueskyConnect(discordUserId: string, handle: string): Promise<BridgeResult<{ url: string }>> {
  try {
    return { ok: true, url: await startAuthorize(discordUserId, handle) };
  } catch (error) {
    return oauthError(error);
  }
}

export async function completeBridgeBlueskyConnect(
  discordUserId: string,
  params: Record<string, string>,
): Promise<BridgeResult<{ account: BridgeBlueskyAccount }>> {
  try {
    const account = await completeCallback(discordUserId, new URLSearchParams(params));
    return {
      ok: true,
      account: {
        did: account.did,
        handle: account.handle,
        displayName: account.displayName,
        avatarUrl: account.avatarUrl,
        connectedAt: account.createdAt.toISOString(),
      },
    };
  } catch (error) {
    return oauthError(error);
  }
}

export async function disconnectBridgeBlueskyAccount(discordUserId: string): Promise<{ ok: true; removed: boolean }> {
  return { ok: true, removed: await disconnect(discordUserId) };
}

export async function getBridgeBlueskyOauthDocuments(): Promise<BridgeResult<{ metadata: unknown; jwks: unknown }>> {
  try {
    return { ok: true, ...(await getPublicOauthDocuments()) };
  } catch (error) {
    return oauthError(error);
  }
}
