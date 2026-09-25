import type { Client } from "discord.js";
import { z } from "zod";
import {
  DEFAULT_BLUESKY_MESSAGE,
  validateBlueskyFeedOptions,
  zBlueskyFeedOptions,
  type BlueskyFeedOptions,
} from "../config/schemas/bluesky.js";
import { BlueskyResolveError, getLatestPost, resolveActor, type BlueskyProfile } from "../plugins/bluesky/functions/api.js";
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
  listFeeds,
  resolveMaxFeeds,
  updateFeed,
  type BlueskyFeedRow,
} from "../plugins/bluesky/functions/store.js";
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

export async function listBridgeBlueskyFeeds(
  guildId: string,
): Promise<BridgeResult<{ feeds: BridgeBlueskyFeed[]; count: number; maxFeeds: number; accountsEnabled: boolean }>> {
  // Like Social Notifications, managing feeds works whether or not the plugin is on; the plugin's
  // enabled flag only gates whether posts are actually delivered (see stream.ts).
  const [rows, oneActive] = await Promise.all([listFeeds(guildId), isDreamlinerOneActive(guildId)]);
  return {
    ok: true,
    feeds: rows.map(serializeFeed),
    count: rows.length,
    maxFeeds: resolveMaxFeeds(oneActive),
    accountsEnabled: isBlueskyOauthConfigured(),
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

  const created = await createFeed({
    guildId,
    discordChannelId: parsed.data.discordChannelId,
    did: profile.did,
    handle: profile.handle,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    messageContent: parsed.data.messageContent ?? DEFAULT_BLUESKY_MESSAGE,
    mentionRoleIds: parsed.data.mentionRoleIds ?? [],
    options: validateBlueskyFeedOptions(parsed.data.options ?? {}),
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
  const updated = await updateFeed(guildId, id, parsed.data);
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
