/**
 * DB access for the feeds engine. Every subscription read or write a server can trigger is scoped
 * by guild_id; the cross-guild helpers (due sources, pending work) are only used by the poller.
 */
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type Database from "better-sqlite3";
import { getDb } from "../../../db/client.js";
import { feedDeliveries, feedItems, feedSources, feedSubscriptions } from "../../../db/schema.js";
import {
  parseFeedFilters,
  parseFeedMessage,
  parseFeedOptions,
  type FeedFilters,
  type FeedMessage,
  type FeedOptions,
  type FeedSourceType,
} from "../../../config/schemas/social.js";
import type { FeedItemInput, FeedSourceRecord } from "./types.js";

/** Free-tier cap, shared by every feed type. Dreamliner One servers get ONE_WATCHERS_LIMIT. */
export const FREE_WATCHERS_LIMIT = 10;
export const ONE_WATCHERS_LIMIT = 50;

export function resolveMaxWatchers(oneActive: boolean): number {
  return oneActive ? ONE_WATCHERS_LIMIT : FREE_WATCHERS_LIMIT;
}

/** Why a server can't add another feed (every type counts toward the one cap), or null. */
export function feedLimitError(count: number, oneActive: boolean): string | null {
  const max = resolveMaxWatchers(oneActive);
  if (count < max) return null;
  return oneActive
    ? `This server already has ${max} feeds. Remove one first.`
    : `This server already has ${max} feeds on the free plan. Remove one, or get Dreamliner One for up to ${ONE_WATCHERS_LIMIT}.`;
}

/** Items first seen longer ago than this are never delivered (a resubscribed old item stays quiet). */
export const DELIVERY_WINDOW_MS = 7 * 24 * 3600_000;
/** An item published this long before we first saw it is old news, not a new post. */
export const MAX_ITEM_AGE_AT_DISCOVERY_MS = 7 * 24 * 3600_000;
/** A send is retried this many times, then left as failed (shown on the dashboard). */
export const MAX_DELIVERY_ATTEMPTS = 5;
/** A 'pending' row older than this is a send that crashed mid-way and is retried. */
export const STALE_PENDING_MS = 5 * 60_000;
export const DELIVERY_RETENTION_MS = 180 * 24 * 3600_000;
export const ITEM_RETENTION_MS = 180 * 24 * 3600_000;
/** Newest items kept per source past the retention window, so dedupe keeps working. */
export const ITEMS_KEPT_PER_SOURCE = 100;

function raw(): Database.Database {
  return (getDb() as unknown as { session: { client: Database.Database } }).session.client;
}

function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringList(value: string): string[] {
  const parsed = json<unknown>(value, []);
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
}

const sec = (date: Date) => Math.floor(date.getTime() / 1000);

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

export type FeedSourceState = {
  /** First fetch only: items published at or before this (ms) are baseline, newer ones post. */
  baselineBefore?: number | null;
  /** Twitch: the stream id currently or last seen live, and when it was last seen live (ms). */
  streamId?: string | null;
  lastSeenLiveAt?: number | null;
  [key: string]: unknown;
};

export type FeedSourceRow = FeedSourceRecord & {
  state: FeedSourceState;
  nextCheckAt: Date;
  intervalS: number;
  failCount: number;
  lastError: string | null;
  disabledReason: string | null;
  lastOkAt: Date | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
};

export function mapSource(row: typeof feedSources.$inferSelect): FeedSourceRow {
  return {
    id: row.id,
    type: row.type as FeedSourceType,
    key: row.key,
    config: json<Record<string, unknown>>(row.config, {}),
    title: row.title,
    iconUrl: row.iconUrl,
    siteUrl: row.siteUrl,
    etag: row.etag,
    lastModified: row.lastModified,
    contentHash: row.contentHash,
    state: json<FeedSourceState>(row.state, {}),
    nextCheckAt: row.nextCheckAt,
    intervalS: row.intervalS,
    failCount: row.failCount,
    lastError: row.lastError,
    disabledReason: row.disabledReason,
    lastOkAt: row.lastOkAt,
    lastCheckedAt: row.lastCheckedAt,
    createdAt: row.createdAt,
  };
}

export type SourceInput = {
  type: FeedSourceType;
  key: string;
  config: Record<string, unknown>;
  title: string;
  iconUrl: string | null;
  siteUrl: string | null;
  intervalS: number;
  state?: FeedSourceState;
};

/** The source with this key, created if it doesn't exist yet. Existing sources keep their state. */
export async function upsertSource(input: SourceInput): Promise<FeedSourceRow> {
  const db = getDb();
  const now = new Date();
  await db
    .insert(feedSources)
    .values({
      type: input.type,
      key: input.key,
      config: JSON.stringify(input.config),
      title: input.title.slice(0, 200),
      iconUrl: input.iconUrl,
      siteUrl: input.siteUrl,
      state: JSON.stringify(input.state ?? {}),
      nextCheckAt: now,
      intervalS: input.intervalS,
      createdAt: now,
    })
    .onConflictDoNothing()
    .run();
  const row = await db.select().from(feedSources).where(eq(feedSources.key, input.key)).get();
  if (!row) throw new Error(`feed source ${input.key} vanished`);
  return mapSource(row);
}

export async function getSource(id: number): Promise<FeedSourceRow | null> {
  const row = await getDb().select().from(feedSources).where(eq(feedSources.id, id)).get();
  return row ? mapSource(row) : null;
}

export async function getSourceByKey(key: string): Promise<FeedSourceRow | null> {
  const row = await getDb().select().from(feedSources).where(eq(feedSources.key, key)).get();
  return row ? mapSource(row) : null;
}

export async function getSourcesByIds(ids: number[]): Promise<Map<number, FeedSourceRow>> {
  const out = new Map<number, FeedSourceRow>();
  if (!ids.length) return out;
  const rows = await getDb().select().from(feedSources).where(inArray(feedSources.id, [...new Set(ids)])).all();
  for (const row of rows) out.set(row.id, mapSource(row));
  return out;
}

/** Polled (non-Twitch) sources that are due and have at least one enabled subscription. */
export function listDueSources(now: Date, limit: number): FeedSourceRow[] {
  const rows = raw()
    .prepare(
      `SELECT src.* FROM feed_sources src
       WHERE src.type != 'twitch' AND src.disabled_reason IS NULL AND src.next_check_at <= ?
         AND EXISTS (SELECT 1 FROM feed_subscriptions s WHERE s.source_id = src.id AND s.enabled = 1)
       ORDER BY src.next_check_at ASC LIMIT ?`,
    )
    .all(sec(now), limit) as Record<string, unknown>[];
  return rows.map(mapRawSource);
}

/** Twitch sources with at least one enabled subscription. */
export function listActiveTwitchSources(): FeedSourceRow[] {
  const rows = raw()
    .prepare(
      `SELECT src.* FROM feed_sources src WHERE src.type = 'twitch'
         AND EXISTS (SELECT 1 FROM feed_subscriptions s WHERE s.source_id = src.id AND s.enabled = 1)`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(mapRawSource);
}

function mapRawSource(row: Record<string, unknown>): FeedSourceRow {
  const date = (v: unknown) => (typeof v === "number" ? new Date(v * 1000) : null);
  return mapSource({
    id: row.id as number,
    type: row.type as string,
    key: row.key as string,
    config: row.config as string,
    title: row.title as string,
    iconUrl: (row.icon_url as string | null) ?? null,
    siteUrl: (row.site_url as string | null) ?? null,
    state: row.state as string,
    etag: (row.etag as string | null) ?? null,
    lastModified: (row.last_modified as string | null) ?? null,
    contentHash: (row.content_hash as string | null) ?? null,
    nextCheckAt: date(row.next_check_at) ?? new Date(0),
    intervalS: row.interval_s as number,
    failCount: row.fail_count as number,
    lastError: (row.last_error as string | null) ?? null,
    disabledReason: (row.disabled_reason as string | null) ?? null,
    lastOkAt: date(row.last_ok_at),
    lastCheckedAt: date(row.last_checked_at),
    createdAt: date(row.created_at) ?? new Date(0),
  });
}

export type SourcePatch = Partial<{
  title: string;
  iconUrl: string | null;
  siteUrl: string | null;
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
  nextCheckAt: Date;
  intervalS: number;
  failCount: number;
  lastError: string | null;
  disabledReason: string | null;
  lastOkAt: Date | null;
  lastCheckedAt: Date | null;
  state: FeedSourceState;
  config: Record<string, unknown>;
}>;

export async function updateSource(id: number, patch: SourcePatch): Promise<void> {
  const { state, config, title, ...rest } = patch;
  const set: Partial<typeof feedSources.$inferInsert> = { ...rest };
  if (title !== undefined) set.title = title.slice(0, 200);
  if (state !== undefined) set.state = JSON.stringify(state);
  if (config !== undefined) set.config = JSON.stringify(config);
  if (!Object.keys(set).length) return;
  await getDb().update(feedSources).set(set).where(eq(feedSources.id, id)).run();
}

/** Make a source due now (a new subscriber, a resumed or retried feed). */
export async function reactivateSource(id: number): Promise<void> {
  await getDb()
    .update(feedSources)
    .set({ disabledReason: null, failCount: 0, lastError: null, nextCheckAt: new Date() })
    .where(eq(feedSources.id, id))
    .run();
}

// ---------------------------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------------------------

export type FeedSubscriptionRow = {
  id: number;
  guildId: string;
  sourceId: number;
  channelId: string;
  enabled: boolean;
  message: FeedMessage;
  mentionRoleIds: string[];
  filters: FeedFilters;
  options: FeedOptions;
  cursorItemId: number;
  deliveredCount: number;
  legacyRef: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export function mapSubscription(row: typeof feedSubscriptions.$inferSelect): FeedSubscriptionRow {
  return {
    id: row.id,
    guildId: row.guildId,
    sourceId: row.sourceId,
    channelId: row.channelId,
    enabled: row.enabled,
    message: parseFeedMessage(json(row.message, {})),
    mentionRoleIds: stringList(row.mentionRoleIds),
    filters: parseFeedFilters(json(row.filters, {})),
    options: parseFeedOptions(json(row.options, {})),
    cursorItemId: row.cursorItemId,
    deliveredCount: row.deliveredCount,
    legacyRef: row.legacyRef,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listSubscriptions(guildId: string): Promise<FeedSubscriptionRow[]> {
  const rows = await getDb()
    .select()
    .from(feedSubscriptions)
    .where(eq(feedSubscriptions.guildId, guildId))
    .orderBy(feedSubscriptions.id)
    .all();
  return rows.map(mapSubscription);
}

export async function getSubscription(guildId: string, id: number): Promise<FeedSubscriptionRow | null> {
  const row = await getDb()
    .select()
    .from(feedSubscriptions)
    .where(and(eq(feedSubscriptions.guildId, guildId), eq(feedSubscriptions.id, id)))
    .get();
  return row ? mapSubscription(row) : null;
}

/** Poller only (cross-guild). */
export async function getSubscriptionById(id: number): Promise<FeedSubscriptionRow | null> {
  const row = await getDb().select().from(feedSubscriptions).where(eq(feedSubscriptions.id, id)).get();
  return row ? mapSubscription(row) : null;
}

export async function countSubscriptions(guildId: string): Promise<number> {
  const row = await getDb()
    .select({ count: sql<number>`count(*)` })
    .from(feedSubscriptions)
    .where(eq(feedSubscriptions.guildId, guildId))
    .get();
  return Number(row?.count ?? 0);
}

/** Poller only: every enabled subscription on a source, across servers. */
export async function listEnabledSubscriptionsForSource(sourceId: number): Promise<FeedSubscriptionRow[]> {
  const rows = await getDb()
    .select()
    .from(feedSubscriptions)
    .where(and(eq(feedSubscriptions.sourceId, sourceId), eq(feedSubscriptions.enabled, true)))
    .all();
  return rows.map(mapSubscription);
}

/** Poller only: every enabled subscription of a type, across servers (YouTube milestones). */
export function listEnabledSubscriptionsOfType(type: FeedSourceType): FeedSubscriptionRow[] {
  const ids = raw()
    .prepare(
      `SELECT s.id FROM feed_subscriptions s JOIN feed_sources src ON src.id = s.source_id WHERE s.enabled = 1 AND src.type = ?`,
    )
    .all(type) as { id: number }[];
  if (!ids.length) return [];
  return getDb()
    .select()
    .from(feedSubscriptions)
    .where(inArray(feedSubscriptions.id, ids.map((r) => r.id)))
    .all()
    .map(mapSubscription);
}

export type SubscriptionInput = {
  guildId: string;
  sourceId: number;
  channelId: string;
  message: FeedMessage;
  mentionRoleIds: string[];
  filters: FeedFilters;
  options: FeedOptions;
  createdBy: string;
  enabled?: boolean;
};

/** New subscription. Its cursor starts at the source's newest item, so nothing older ever posts. */
export async function createSubscription(input: SubscriptionInput): Promise<FeedSubscriptionRow> {
  const now = new Date();
  const row = await getDb()
    .insert(feedSubscriptions)
    .values({
      guildId: input.guildId,
      sourceId: input.sourceId,
      channelId: input.channelId,
      enabled: input.enabled ?? true,
      message: JSON.stringify(input.message),
      mentionRoleIds: JSON.stringify(input.mentionRoleIds),
      filters: JSON.stringify(input.filters),
      options: JSON.stringify(input.options),
      cursorItemId: maxItemId(input.sourceId),
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return mapSubscription(row);
}

export type SubscriptionPatch = Partial<{
  channelId: string;
  enabled: boolean;
  message: FeedMessage;
  mentionRoleIds: string[];
  filters: FeedFilters;
  options: FeedOptions;
  cursorItemId: number;
}>;

export async function updateSubscription(guildId: string, id: number, patch: SubscriptionPatch): Promise<FeedSubscriptionRow | null> {
  const set: Partial<typeof feedSubscriptions.$inferInsert> = { updatedAt: new Date() };
  if (patch.channelId !== undefined) set.channelId = patch.channelId;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.message !== undefined) set.message = JSON.stringify(patch.message);
  if (patch.mentionRoleIds !== undefined) set.mentionRoleIds = JSON.stringify(patch.mentionRoleIds);
  if (patch.filters !== undefined) set.filters = JSON.stringify(patch.filters);
  if (patch.options !== undefined) set.options = JSON.stringify(patch.options);
  if (patch.cursorItemId !== undefined) set.cursorItemId = patch.cursorItemId;
  const row = await getDb()
    .update(feedSubscriptions)
    .set(set)
    .where(and(eq(feedSubscriptions.guildId, guildId), eq(feedSubscriptions.id, id)))
    .returning()
    .get();
  return row ? mapSubscription(row) : null;
}

/** Options the bot itself changes (the milestone it last announced). Poller only. */
export async function setSubscriptionOptions(id: number, options: FeedOptions): Promise<void> {
  await getDb().update(feedSubscriptions).set({ options: JSON.stringify(options) }).where(eq(feedSubscriptions.id, id)).run();
}

export async function deleteSubscription(guildId: string, id: number): Promise<FeedSubscriptionRow | null> {
  const row = await getDb()
    .delete(feedSubscriptions)
    .where(and(eq(feedSubscriptions.guildId, guildId), eq(feedSubscriptions.id, id)))
    .returning()
    .get();
  if (!row) return null;
  await getDb().delete(feedDeliveries).where(eq(feedDeliveries.subscriptionId, id)).run();
  return mapSubscription(row);
}

// ---------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------

export type FeedItemRow = {
  id: number;
  sourceId: number;
  itemKey: string;
  title: string;
  url: string;
  imageUrl: string | null;
  summary: string;
  author: string | null;
  tags: string[];
  publishedAt: Date | null;
  firstSeenAt: Date;
  baseline: boolean;
  payload: Record<string, unknown>;
};

export function mapItem(row: typeof feedItems.$inferSelect): FeedItemRow {
  return {
    id: row.id,
    sourceId: row.sourceId,
    itemKey: row.itemKey,
    title: row.title,
    url: row.url,
    imageUrl: row.imageUrl,
    summary: row.summary,
    author: row.author,
    tags: stringList(row.tags),
    publishedAt: row.publishedAt,
    firstSeenAt: row.firstSeenAt,
    baseline: row.baseline,
    payload: json<Record<string, unknown>>(row.payload, {}),
  };
}

export function maxItemId(sourceId: number): number {
  const row = raw().prepare(`SELECT max(id) AS id FROM feed_items WHERE source_id = ?`).get(sourceId) as { id: number | null } | undefined;
  return row?.id ?? 0;
}

/** Which of these keys a source already has. */
export function knownItemKeys(sourceId: number, keys: string[]): Set<string> {
  const out = new Set<string>();
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    const rows = raw()
      .prepare(`SELECT item_key FROM feed_items WHERE source_id = ? AND item_key IN (${chunk.map(() => "?").join(",")})`)
      .all(sourceId, ...chunk) as { item_key: string }[];
    for (const row of rows) out.add(row.item_key);
  }
  return out;
}

/**
 * Store new items (already-known keys are ignored). `baseline` marks them as seen-but-never-post:
 * true for all, false for none, or a function per item (the first-fetch watermark).
 */
export async function insertItems(
  sourceId: number,
  items: FeedItemInput[],
  baseline: boolean | ((item: FeedItemInput) => boolean),
  now: Date = new Date(),
): Promise<FeedItemRow[]> {
  if (!items.length) return [];
  const rows = await getDb()
    .insert(feedItems)
    .values(
      items.map((item) => ({
        sourceId,
        itemKey: item.key.slice(0, 500),
        title: item.title.slice(0, 300),
        url: item.url.slice(0, 1000),
        imageUrl: item.imageUrl?.slice(0, 1000) ?? null,
        summary: item.summary.slice(0, 600),
        author: item.author?.slice(0, 120) ?? null,
        tags: JSON.stringify(item.tags.slice(0, 15)),
        publishedAt: item.publishedAt,
        firstSeenAt: now,
        baseline: typeof baseline === "function" ? baseline(item) : baseline,
        payload: JSON.stringify(item.payload ?? {}),
      })),
    )
    .onConflictDoNothing()
    .returning()
    .all();
  return rows.map(mapItem);
}

export async function upsertItem(sourceId: number, item: FeedItemInput, baseline: boolean): Promise<FeedItemRow> {
  await insertItems(sourceId, [item], baseline);
  const row = await getDb()
    .select()
    .from(feedItems)
    .where(and(eq(feedItems.sourceId, sourceId), eq(feedItems.itemKey, item.key.slice(0, 500))))
    .get();
  return mapItem(row!);
}

export async function updateItem(id: number, patch: Partial<Pick<FeedItemRow, "title" | "imageUrl" | "payload" | "tags">>): Promise<void> {
  const set: Partial<typeof feedItems.$inferInsert> = {};
  if (patch.title !== undefined) set.title = patch.title.slice(0, 300);
  if (patch.imageUrl !== undefined) set.imageUrl = patch.imageUrl;
  if (patch.payload !== undefined) set.payload = JSON.stringify(patch.payload);
  if (patch.tags !== undefined) set.tags = JSON.stringify(patch.tags);
  if (!Object.keys(set).length) return;
  await getDb().update(feedItems).set(set).where(eq(feedItems.id, id)).run();
}

export async function getItem(id: number): Promise<FeedItemRow | null> {
  const row = await getDb().select().from(feedItems).where(eq(feedItems.id, id)).get();
  return row ? mapItem(row) : null;
}

/** Newest items of a source (by publish time, then first-seen). */
export function latestItems(sourceId: number, limit = 5): FeedItemRow[] {
  const ids = raw()
    .prepare(`SELECT id FROM feed_items WHERE source_id = ? ORDER BY coalesce(published_at, first_seen_at) DESC, id DESC LIMIT ?`)
    .all(sourceId, limit) as { id: number }[];
  if (!ids.length) return [];
  const rows = getDb().select().from(feedItems).where(inArray(feedItems.id, ids.map((r) => r.id))).all().map(mapItem);
  const order = new Map(ids.map((r, i) => [r.id, i]));
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

// ---------------------------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------------------------

export type DeliveryStatus = "pending" | "sent" | "failed" | "filtered" | "continued";

export type FeedDeliveryRow = {
  id: number;
  subscriptionId: number;
  itemId: number;
  guildId: string;
  channelId: string;
  messageId: string | null;
  status: DeliveryStatus;
  attempts: number;
  error: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export function mapDelivery(row: typeof feedDeliveries.$inferSelect): FeedDeliveryRow {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    itemId: row.itemId,
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    status: row.status as DeliveryStatus,
    attempts: row.attempts,
    error: row.error,
    payload: json<Record<string, unknown>>(row.payload, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const CANDIDATE_WHERE = `
  i.baseline = 0 AND i.id > s.cursor_item_id AND i.first_seen_at >= @windowStart
  AND (i.published_at IS NULL OR i.published_at >= i.first_seen_at - @maxAge)
  AND (d.id IS NULL
       OR (d.status = 'failed' AND d.attempts < @maxAttempts)
       OR (d.status = 'pending' AND d.updated_at < @staleBefore))`;

function candidateParams(now: Date) {
  return {
    windowStart: sec(new Date(now.getTime() - DELIVERY_WINDOW_MS)),
    maxAge: Math.floor(MAX_ITEM_AGE_AT_DISCOVERY_MS / 1000),
    maxAttempts: MAX_DELIVERY_ATTEMPTS,
    staleBefore: sec(new Date(now.getTime() - STALE_PENDING_MS)),
  };
}

/** Poller only: enabled non-Twitch subscriptions that have something to deliver. */
export function subscriptionsWithPendingItems(now: Date = new Date()): number[] {
  const rows = raw()
    .prepare(
      `SELECT DISTINCT s.id AS id FROM feed_subscriptions s
       JOIN feed_sources src ON src.id = s.source_id
       JOIN feed_items i ON i.source_id = s.source_id
       LEFT JOIN feed_deliveries d ON d.subscription_id = s.id AND d.item_id = i.id
       WHERE s.enabled = 1 AND src.type != 'twitch' AND ${CANDIDATE_WHERE}`,
    )
    .all(candidateParams(now)) as { id: number }[];
  return rows.map((r) => r.id);
}

/** Items this subscription still has to deliver (or decide to filter), oldest first. */
export function pendingItemsFor(subscription: Pick<FeedSubscriptionRow, "id" | "sourceId">, limit: number, now: Date = new Date()): FeedItemRow[] {
  const ids = raw()
    .prepare(
      `SELECT i.id AS id FROM feed_items i
       JOIN feed_subscriptions s ON s.id = @subId
       LEFT JOIN feed_deliveries d ON d.subscription_id = s.id AND d.item_id = i.id
       WHERE i.source_id = @sourceId AND ${CANDIDATE_WHERE}
       ORDER BY coalesce(i.published_at, i.first_seen_at) ASC, i.id ASC LIMIT @limit`,
    )
    .all({ ...candidateParams(now), subId: subscription.id, sourceId: subscription.sourceId, limit }) as { id: number }[];
  if (!ids.length) return [];
  const rows = getDb().select().from(feedItems).where(inArray(feedItems.id, ids.map((r) => r.id))).all().map(mapItem);
  const order = new Map(ids.map((r, i) => [r.id, i]));
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

/**
 * Claim the (subscription, item) pair for sending. Returns the delivery id, or null when another
 * tick/process already sent or is sending it: the unique key makes this the dedupe.
 */
export function reserveDelivery(
  subscription: Pick<FeedSubscriptionRow, "id" | "guildId" | "channelId">,
  itemId: number,
  now: Date = new Date(),
): number | null {
  const db = raw();
  const nowS = sec(now);
  const inserted = db
    .prepare(
      `INSERT INTO feed_deliveries (subscription_id, item_id, guild_id, channel_id, status, attempts, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 1, '{}', ?, ?)
       ON CONFLICT (subscription_id, item_id) DO NOTHING RETURNING id`,
    )
    .get(subscription.id, itemId, subscription.guildId, subscription.channelId, nowS, nowS) as { id: number } | undefined;
  if (inserted) return inserted.id;
  const claimed = db
    .prepare(
      `UPDATE feed_deliveries SET status = 'pending', attempts = attempts + 1, channel_id = ?, updated_at = ?, error = NULL
       WHERE subscription_id = ? AND item_id = ?
         AND ((status = 'failed' AND attempts < ?) OR (status = 'pending' AND updated_at < ?))
       RETURNING id`,
    )
    .get(subscription.channelId, nowS, subscription.id, itemId, MAX_DELIVERY_ATTEMPTS, sec(new Date(now.getTime() - STALE_PENDING_MS))) as
    | { id: number }
    | undefined;
  return claimed?.id ?? null;
}

/** Mark a reserved delivery sent. Only now does it count (the checkpoint moves after the send). */
export function completeDelivery(id: number, messageId: string, channelId: string, payload: Record<string, unknown> = {}): void {
  const db = raw();
  const nowS = sec(new Date());
  db.transaction(() => {
    const row = db
      .prepare(
        `UPDATE feed_deliveries SET status = 'sent', message_id = ?, channel_id = ?, payload = ?, updated_at = ? WHERE id = ? AND status = 'pending' RETURNING subscription_id`,
      )
      .get(messageId, channelId, JSON.stringify(payload), nowS, id) as { subscription_id: number } | undefined;
    if (row) db.prepare(`UPDATE feed_subscriptions SET delivered_count = delivered_count + 1 WHERE id = ?`).run(row.subscription_id);
  })();
}

export function failDelivery(id: number, error: string): void {
  raw()
    .prepare(`UPDATE feed_deliveries SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
    .run(error.slice(0, 300), sec(new Date()), id);
}

/** An item a subscription's filters skipped: recorded so it's never reconsidered, and shown as filtered. */
export function recordFiltered(subscription: Pick<FeedSubscriptionRow, "id" | "guildId" | "channelId">, itemId: number, reason: string): void {
  const nowS = sec(new Date());
  raw()
    .prepare(
      `INSERT INTO feed_deliveries (subscription_id, item_id, guild_id, channel_id, status, attempts, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'filtered', 0, ?, ?, ?)
       ON CONFLICT (subscription_id, item_id) DO UPDATE SET status = 'filtered', payload = excluded.payload, updated_at = excluded.updated_at
       WHERE feed_deliveries.status IN ('failed', 'pending')`,
    )
    .run(subscription.id, itemId, subscription.guildId, subscription.channelId, JSON.stringify({ reason }), nowS, nowS);
}

/** Insert a finished delivery directly (Twitch continued sessions). Null when the pair exists. */
export function insertDelivery(input: {
  subscriptionId: number;
  itemId: number;
  guildId: string;
  channelId: string;
  messageId: string | null;
  status: DeliveryStatus;
  payload: Record<string, unknown>;
}): number | null {
  const nowS = sec(new Date());
  const row = raw()
    .prepare(
      `INSERT INTO feed_deliveries (subscription_id, item_id, guild_id, channel_id, message_id, status, attempts, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?) ON CONFLICT (subscription_id, item_id) DO NOTHING RETURNING id`,
    )
    .get(input.subscriptionId, input.itemId, input.guildId, input.channelId, input.messageId, input.status, JSON.stringify(input.payload), nowS, nowS) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

export async function updateDeliveryPayload(id: number, payload: Record<string, unknown>): Promise<void> {
  await getDb().update(feedDeliveries).set({ payload: JSON.stringify(payload), updatedAt: new Date() }).where(eq(feedDeliveries.id, id)).run();
}

export async function getDeliveryFor(subscriptionId: number, itemId: number): Promise<FeedDeliveryRow | null> {
  const row = await getDb()
    .select()
    .from(feedDeliveries)
    .where(and(eq(feedDeliveries.subscriptionId, subscriptionId), eq(feedDeliveries.itemId, itemId)))
    .get();
  return row ? mapDelivery(row) : null;
}

/** The newest real post (sent or continued) of a subscription, for cooldowns and Twitch sessions. */
export async function latestPostedDelivery(subscriptionId: number): Promise<FeedDeliveryRow | null> {
  const row = await getDb()
    .select()
    .from(feedDeliveries)
    .where(and(eq(feedDeliveries.subscriptionId, subscriptionId), inArray(feedDeliveries.status, ["sent", "continued"])))
    .orderBy(desc(feedDeliveries.createdAt), desc(feedDeliveries.id))
    .limit(1)
    .get();
  return row ? mapDelivery(row) : null;
}

/** Recent items of a source with what this subscription did with each (posted, filtered...). */
export function recentItemsWithDeliveries(
  subscription: Pick<FeedSubscriptionRow, "id" | "sourceId">,
  limit = 20,
): { item: FeedItemRow; delivery: FeedDeliveryRow | null }[] {
  const items = latestItems(subscription.sourceId, limit);
  if (!items.length) return [];
  const deliveries = getDb()
    .select()
    .from(feedDeliveries)
    .where(and(eq(feedDeliveries.subscriptionId, subscription.id), inArray(feedDeliveries.itemId, items.map((i) => i.id))))
    .all()
    .map(mapDelivery);
  const byItem = new Map(deliveries.map((d) => [d.itemId, d]));
  return items.map((item) => ({ item, delivery: byItem.get(item.id) ?? null }));
}

export async function pruneFeeds(now: Date = new Date()): Promise<void> {
  const db = getDb();
  await db.delete(feedDeliveries).where(lt(feedDeliveries.createdAt, new Date(now.getTime() - DELIVERY_RETENTION_MS))).run();
  const r = raw();
  // Old items, except each source's newest few (they're still in the upstream feed, so they're
  // needed for dedupe) and anything a recent delivery points at.
  r.prepare(
    `DELETE FROM feed_items WHERE first_seen_at < ?
       AND id NOT IN (SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY source_id ORDER BY id DESC) AS n FROM feed_items) WHERE n <= ?)
       AND id NOT IN (SELECT item_id FROM feed_deliveries)`,
  ).run(sec(new Date(now.getTime() - ITEM_RETENTION_MS)), ITEMS_KEPT_PER_SOURCE);
  // Sources nobody follows any more, and their items.
  r.prepare(`DELETE FROM feed_items WHERE source_id IN (SELECT id FROM feed_sources src WHERE NOT EXISTS (SELECT 1 FROM feed_subscriptions s WHERE s.source_id = src.id) AND src.created_at < ?)`).run(
    sec(new Date(now.getTime() - 24 * 3600_000)),
  );
  r.prepare(`DELETE FROM feed_sources WHERE NOT EXISTS (SELECT 1 FROM feed_subscriptions s WHERE s.source_id = feed_sources.id) AND created_at < ?`).run(
    sec(new Date(now.getTime() - 24 * 3600_000)),
  );
}

// ---------------------------------------------------------------------------------------------
// Dashboard stats
// ---------------------------------------------------------------------------------------------

export const STATS_DAYS = 30;
const DAY_MS = 24 * 3600_000;

export type FeedSubscriptionStats = {
  delivered30d: number;
  deliveredAll: number;
  /** Posts per day, oldest first, STATS_DAYS entries ending today. */
  daily: number[];
  lastPostedAt: string | null;
  /** Sends that gave up after MAX_DELIVERY_ATTEMPTS in the last 30 days. */
  failed30d: number;
};

/** 0 = the oldest day, STATS_DAYS - 1 = the last 24 hours. */
export function dayBucket(createdAtMs: number, nowMs: number): number | null {
  const age = Math.floor((nowMs - createdAtMs) / DAY_MS);
  if (age < 0) return STATS_DAYS - 1;
  if (age >= STATS_DAYS) return null;
  return STATS_DAYS - 1 - age;
}

export async function guildFeedStats(guildId: string, subscriptions: FeedSubscriptionRow[]): Promise<Map<number, FeedSubscriptionStats>> {
  const now = Date.now();
  const stats = new Map<number, FeedSubscriptionStats>();
  for (const sub of subscriptions) {
    stats.set(sub.id, { delivered30d: 0, deliveredAll: sub.deliveredCount, daily: Array<number>(STATS_DAYS).fill(0), lastPostedAt: null, failed30d: 0 });
  }
  const rows = await getDb()
    .select({ subscriptionId: feedDeliveries.subscriptionId, status: feedDeliveries.status, createdAt: feedDeliveries.createdAt })
    .from(feedDeliveries)
    .where(and(eq(feedDeliveries.guildId, guildId), gte(feedDeliveries.createdAt, new Date(now - STATS_DAYS * DAY_MS))))
    .all();
  for (const row of rows) {
    const entry = stats.get(row.subscriptionId);
    if (!entry) continue;
    if (row.status === "failed") {
      entry.failed30d += 1;
      continue;
    }
    if (row.status !== "sent") continue;
    const bucket = dayBucket(row.createdAt.getTime(), now);
    if (bucket === null) continue;
    entry.daily[bucket]! += 1;
    entry.delivered30d += 1;
  }
  const last = raw()
    .prepare(`SELECT subscription_id AS id, max(created_at) AS at FROM feed_deliveries WHERE guild_id = ? AND status = 'sent' GROUP BY subscription_id`)
    .all(guildId) as { id: number; at: number | null }[];
  for (const row of last) {
    const entry = stats.get(row.id);
    if (entry && row.at) entry.lastPostedAt = new Date(row.at * 1000).toISOString();
  }
  return stats;
}

export async function recentGuildDeliveries(guildId: string, limit = 10): Promise<(FeedDeliveryRow & { item: FeedItemRow | null })[]> {
  const rows = await getDb()
    .select()
    .from(feedDeliveries)
    .where(and(eq(feedDeliveries.guildId, guildId), eq(feedDeliveries.status, "sent")))
    .orderBy(desc(feedDeliveries.createdAt), desc(feedDeliveries.id))
    .limit(limit)
    .all();
  const deliveries = rows.map(mapDelivery);
  const itemIds = deliveries.map((d) => d.itemId);
  const items = itemIds.length ? getDb().select().from(feedItems).where(inArray(feedItems.id, itemIds)).all().map(mapItem) : [];
  const byId = new Map(items.map((i) => [i.id, i]));
  return deliveries.map((d) => ({ ...d, item: byId.get(d.itemId) ?? null }));
}

/** The Twitch session of a subscription still waiting for its stream-ended handling, if any. */
export function openTwitchSession(subscriptionId: number): FeedDeliveryRow | null {
  const row = raw()
    .prepare(
      `SELECT id FROM feed_deliveries WHERE subscription_id = ? AND status IN ('sent', 'continued')
         AND json_extract(payload, '$.endedAt') IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(subscriptionId) as { id: number } | undefined;
  if (!row) return null;
  const full = getDb().select().from(feedDeliveries).where(eq(feedDeliveries.id, row.id)).get();
  return full ? mapDelivery(full) : null;
}
