/**
 * Real-time delivery over Jetstream (Bluesky's public JSON event stream). One WebSocket for the
 * whole bot, filtered to posts and reposts by the DIDs of every enabled feed. When feeds change,
 * the socket reconnects with the new DID list from the last cursor, so nothing is missed.
 *
 * Posts are hydrated through the public AppView before sending, which also gives the author's
 * current name/avatar and embed views (images, quotes, link cards).
 */
import type { Client } from "discord.js";
import { eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { blueskyStreamState } from "../../../db/schema.js";
import type { BlueskyFeedOptions } from "../../../config/schemas/bluesky.js";
import { getLogger } from "../../../core/logger.js";
import { getPosts, getProfile, parseAtUri, type BlueskyPost, type BlueskyPostKind, type BlueskyProfile } from "./api.js";
import { activeBlueskySettings } from "./guildSettings.js";
import { deliverPost } from "./notify.js";
import { listAllEnabledFeeds, touchFeedPost, type BlueskyFeedRow } from "./store.js";
const log = getLogger("bluesky");

const HOSTS = ["jetstream.us-east.bsky.network", "jetstream.us-west.bsky.network"];
const PATH = "/xrpc/network.bsky.jetstream.subscribeEvents";
const COLLECTIONS = ["app.bsky.feed.post", "app.bsky.feed.repost"];
/** DIDs go in the socket URL; past this many the URL gets too long, so the stream takes every
 *  post and reposts instead and filters by DID here (a few hundred events a second, still cheap). */
const MAX_URL_DIDS = 150;
/** Don't replay a backlog older than this after downtime; old posts would just flood channels. */
const MAX_REPLAY_AGE_MS = 15 * 60_000;
const CURSOR_SAVE_MS = 30_000;
const RESUBSCRIBE_DEBOUNCE_MS = 3_000;
/** Posts claiming to be older than this (backdated imports) aren't announced as new. */
const MAX_POST_AGE_MS = 24 * 60 * 60_000;
/** A post can reach Jetstream a moment before the AppView has indexed it. */
const HYDRATE_RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

export type StreamCommit = {
  did: string;
  seq: number;
  time: string;
  operation: "create" | "update" | "delete";
  collection: string;
  rkey: string;
  cid?: string;
  record?: {
    text?: string;
    reply?: unknown;
    embed?: { $type?: string; media?: { $type?: string } };
    subject?: { uri?: string; cid?: string };
  };
};

// ---------------------------------------------------------------------------------------------
// Pure helpers (tested in stream.test.ts)
// ---------------------------------------------------------------------------------------------

/** Post, reply, quote or repost, straight from the raw record so filtering needs no network call. */
export function classifyCommit(commit: StreamCommit): BlueskyPostKind | null {
  if (commit.operation !== "create" || !commit.record) return null;
  if (commit.collection === "app.bsky.feed.repost") return commit.record.subject?.uri ? "repost" : null;
  if (commit.collection !== "app.bsky.feed.post") return null;
  if (commit.record.reply) return "reply";
  const embedType = commit.record.embed?.$type ?? "";
  if (embedType.startsWith("app.bsky.embed.record")) return "quote";
  return "post";
}

/** Whether the raw record carries images or video (directly, or next to a quote). */
export function recordHasMedia(commit: StreamCommit): boolean {
  const embed = commit.record?.embed;
  const types = [embed?.$type ?? "", embed?.media?.$type ?? ""];
  return types.some((t) => t.startsWith("app.bsky.embed.images") || t.startsWith("app.bsky.embed.video"));
}

/** Kind filters. `media_only` is checked later against the hydrated post (reposts need the subject). */
export function passesKindFilter(kind: BlueskyPostKind, options: BlueskyFeedOptions): boolean {
  if (kind === "reply") return options.include_replies;
  if (kind === "repost") return options.include_reposts;
  if (kind === "quote") return options.include_quotes;
  return true;
}

export function postHasMedia(post: BlueskyPost): boolean {
  return post.images.length > 0 || post.videoThumbnailUrl !== null;
}

export function buildSubscribeUrl(host: string, dids: string[], cursor: number | null): string {
  const params = new URLSearchParams();
  for (const collection of COLLECTIONS) params.append("collections", collection);
  for (const did of dids) params.append("dids", did);
  if (cursor !== null) params.set("cursor", String(cursor));
  return `wss://${host}${PATH}?${params.toString()}`;
}

// ---------------------------------------------------------------------------------------------
// Cursor persistence
// ---------------------------------------------------------------------------------------------

async function loadCursor(): Promise<number | null> {
  const row = await getDb().select().from(blueskyStreamState).where(eq(blueskyStreamState.id, "global")).get();
  if (!row) return null;
  return Date.now() - row.updatedAt.getTime() <= MAX_REPLAY_AGE_MS ? row.cursor : null;
}

async function saveCursor(cursor: number): Promise<void> {
  const now = new Date();
  await getDb()
    .insert(blueskyStreamState)
    .values({ id: "global", cursor, updatedAt: now })
    .onConflictDoUpdate({ target: blueskyStreamState.id, set: { cursor, updatedAt: now } })
    .run();
}

// ---------------------------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------------------------

let client: Client | null = null;
let socket: WebSocket | null = null;
let feedsByDid = new Map<string, BlueskyFeedRow[]>();
let cursor: number | null = null;
let savedCursor: number | null = null;
let hostIndex = 0;
let backoffMs = 1_000;
let reconnectTimer: NodeJS.Timeout | null = null;
let resubscribeTimer: NodeJS.Timeout | null = null;
let cursorTimer: NodeJS.Timeout | null = null;

async function loadFeeds(): Promise<void> {
  const next = new Map<string, BlueskyFeedRow[]>();
  for (const feed of await listAllEnabledFeeds()) {
    const list = next.get(feed.did) ?? [];
    list.push(feed);
    next.set(feed.did, list);
  }
  feedsByDid = next;
}

function closeSocket(): void {
  if (!socket) return;
  const old = socket;
  socket = null;
  old.onclose = null;
  old.onmessage = null;
  old.onerror = null;
  try {
    old.close();
  } catch {
    // already closed
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, 60_000);
  hostIndex = (hostIndex + 1) % HOSTS.length;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect(): void {
  closeSocket();
  const dids = [...feedsByDid.keys()];
  if (!dids.length) return; // nothing to follow; refreshStreamSubscription reconnects once there is

  const ws = new WebSocket(buildSubscribeUrl(HOSTS[hostIndex]!, dids.length <= MAX_URL_DIDS ? dids : [], cursor));
  socket = ws;
  ws.onopen = () => {
    backoffMs = 1_000;
    log.info(`[bluesky] Jetstream connected (${HOSTS[hostIndex]}, ${dids.length} accounts).`);
  };
  ws.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    try {
      const envelope = JSON.parse(event.data) as { payload?: StreamCommit & { $type?: string } };
      const payload = envelope.payload;
      if (!payload?.$type?.endsWith("#commit")) return;
      cursor = payload.seq;
      void handleCommit(payload);
    } catch (error) {
      log.warn("[bluesky] unreadable Jetstream message:", error);
    }
  };
  ws.onerror = () => {
    // onclose follows; reconnect happens there.
  };
  ws.onclose = (event) => {
    if (socket !== ws) return;
    socket = null;
    log.warn(`[bluesky] Jetstream closed (${event.code}); reconnecting.`);
    scheduleReconnect();
  };
}

/** Re-reads feeds and reconnects with the new DID list. Debounced; call after any feed change. */
export function refreshStreamSubscription(): void {
  if (!client) return;
  if (resubscribeTimer) clearTimeout(resubscribeTimer);
  resubscribeTimer = setTimeout(() => {
    resubscribeTimer = null;
    void loadFeeds()
      .then(connect)
      .catch((error: unknown) => log.error("[bluesky] failed to refresh the Jetstream subscription:", error));
  }, RESUBSCRIBE_DEBOUNCE_MS);
}

export async function startBlueskyStream(discordClient: Client): Promise<void> {
  client = discordClient;
  cursor = await loadCursor().catch(() => null);
  await loadFeeds();
  connect();
  cursorTimer ??= setInterval(() => {
    if (cursor === null || cursor === savedCursor) return;
    savedCursor = cursor;
    void saveCursor(cursor).catch((error: unknown) => log.warn("[bluesky] failed to save the stream cursor:", error));
  }, CURSOR_SAVE_MS);
}

// ---------------------------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------------------------

async function hydrate(uri: string): Promise<BlueskyPost | null> {
  for (const delay of [0, ...HYDRATE_RETRY_DELAYS_MS]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const post = (await getPosts([uri]).catch(() => []))[0];
    if (post) return post;
  }
  return null;
}

async function replyParentHandle(post: BlueskyPost): Promise<string | null> {
  const parent = post.replyParentUri ? parseAtUri(post.replyParentUri) : null;
  if (!parent) return null;
  if (parent.did === post.author.did) return post.author.handle;
  const profile = await getProfile(parent.did).catch(() => null);
  return profile?.handle ?? null;
}

async function handleCommit(commit: StreamCommit): Promise<void> {
  const feeds = feedsByDid.get(commit.did);
  if (!feeds?.length || !client) return;
  const kind = classifyCommit(commit);
  if (!kind) return;

  const matching = feeds.filter((feed) => passesKindFilter(kind, feed.options));
  if (!matching.length) return;
  // Cheap pre-check for plain posts; reposts are checked after hydrating the reposted post.
  if (kind !== "repost" && !recordHasMedia(commit) && matching.every((feed) => feed.options.media_only)) return;

  const uri = kind === "repost" ? commit.record!.subject!.uri! : `at://${commit.did}/${commit.collection}/${commit.rkey}`;
  const post = await hydrate(uri);
  if (!post) {
    log.warn(`[bluesky] couldn't load ${uri} to deliver it.`);
    return;
  }
  if (kind !== "repost" && Date.now() - post.createdAt.getTime() > MAX_POST_AGE_MS) return;

  let creator: BlueskyProfile | null = null;
  const needsCreatorProfile = kind === "repost" || matching.some((feed) => /\{creator_(followers|posts)\}/.test(feed.messageContent));
  if (needsCreatorProfile) creator = await getProfile(commit.did).catch(() => null);
  const creatorActor = kind === "repost" ? creator : { ...post.author, ...(creator ?? {}) };
  if (!creatorActor) return;
  const replyToHandle = kind === "reply" ? await replyParentHandle(post) : null;

  const guildActive = new Map<string, boolean>();
  for (const feed of matching) {
    if (feed.options.media_only && !postHasMedia(post)) continue;
    if (!guildActive.has(feed.guildId)) guildActive.set(feed.guildId, Boolean(await activeBlueskySettings(feed.guildId)));
    if (!guildActive.get(feed.guildId)) continue;

    const sent = await deliverPost(client, { feed, post, kind, creator: creatorActor, replyToHandle });
    if (sent) {
      await touchFeedPost(feed.id, {
        handle: creatorActor.handle,
        displayName: creatorActor.displayName,
        avatarUrl: creatorActor.avatarUrl,
      }).catch(() => undefined);
    }
  }
}
