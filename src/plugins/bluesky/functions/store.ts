import { and, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { blueskyDeliveries, blueskyFeeds } from "../../../db/schema.js";
import { validateBlueskyFeedOptions, type BlueskyFeedOptions } from "../../../config/schemas/bluesky.js";

/** Same caps as Social Notifications. */
export const FREE_FEEDS_LIMIT = 10;
export const ONE_FEEDS_LIMIT = 50;

export function resolveMaxFeeds(oneActive: boolean): number {
  return oneActive ? ONE_FEEDS_LIMIT : FREE_FEEDS_LIMIT;
}

export type BlueskyFeedRow = {
  id: number;
  guildId: string;
  discordChannelId: string;
  did: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  messageContent: string;
  mentionRoleIds: string[];
  options: BlueskyFeedOptions;
  lastPostAt: Date | null;
  deliveredCount: number;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type BlueskyDeliveryRow = typeof blueskyDeliveries.$inferSelect;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function mapRow(row: typeof blueskyFeeds.$inferSelect): BlueskyFeedRow {
  const roles = parseJson(row.mentionRoleIds);
  let options: BlueskyFeedOptions;
  try {
    options = validateBlueskyFeedOptions(parseJson(row.options));
  } catch {
    options = validateBlueskyFeedOptions({});
  }
  return {
    ...row,
    mentionRoleIds: Array.isArray(roles) ? roles.filter((v): v is string => typeof v === "string") : [],
    options,
  };
}

export async function listFeeds(guildId: string): Promise<BlueskyFeedRow[]> {
  const rows = await getDb().select().from(blueskyFeeds).where(eq(blueskyFeeds.guildId, guildId)).all();
  return rows.map(mapRow);
}

/** Cross-guild, used to build the Jetstream subscription. */
export async function listAllEnabledFeeds(): Promise<BlueskyFeedRow[]> {
  const rows = await getDb().select().from(blueskyFeeds).where(eq(blueskyFeeds.enabled, true)).all();
  return rows.map(mapRow);
}

export async function getFeed(guildId: string, id: number): Promise<BlueskyFeedRow | null> {
  const row = await getDb()
    .select()
    .from(blueskyFeeds)
    .where(and(eq(blueskyFeeds.guildId, guildId), eq(blueskyFeeds.id, id)))
    .get();
  return row ? mapRow(row) : null;
}

export async function countFeeds(guildId: string): Promise<number> {
  const row = await getDb()
    .select({ count: sql<number>`count(*)` })
    .from(blueskyFeeds)
    .where(eq(blueskyFeeds.guildId, guildId))
    .get();
  return Number(row?.count ?? 0);
}

export async function createFeed(input: {
  guildId: string;
  discordChannelId: string;
  did: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  messageContent: string;
  mentionRoleIds: string[];
  options: BlueskyFeedOptions;
  createdBy: string;
}): Promise<BlueskyFeedRow> {
  const now = new Date();
  const row = await getDb()
    .insert(blueskyFeeds)
    .values({
      ...input,
      mentionRoleIds: JSON.stringify(input.mentionRoleIds),
      options: JSON.stringify(input.options),
      lastPostAt: null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return mapRow(row);
}

export async function updateFeed(
  guildId: string,
  id: number,
  patch: {
    discordChannelId?: string;
    messageContent?: string;
    mentionRoleIds?: string[];
    options?: BlueskyFeedOptions;
    enabled?: boolean;
  },
): Promise<BlueskyFeedRow | null> {
  const row = await getDb()
    .update(blueskyFeeds)
    .set({
      ...(patch.discordChannelId !== undefined ? { discordChannelId: patch.discordChannelId } : {}),
      ...(patch.messageContent !== undefined ? { messageContent: patch.messageContent } : {}),
      ...(patch.mentionRoleIds !== undefined ? { mentionRoleIds: JSON.stringify(patch.mentionRoleIds) } : {}),
      ...(patch.options !== undefined ? { options: JSON.stringify(patch.options) } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(blueskyFeeds.guildId, guildId), eq(blueskyFeeds.id, id)))
    .returning()
    .get();
  return row ? mapRow(row) : null;
}

/** Keeps the stored name/avatar fresh from the post author that just came in. */
export async function touchFeedPost(
  id: number,
  author: { handle: string; displayName: string; avatarUrl: string | null },
): Promise<void> {
  await getDb()
    .update(blueskyFeeds)
    .set({
      lastPostAt: new Date(),
      handle: author.handle,
      displayName: author.displayName,
      avatarUrl: author.avatarUrl,
      deliveredCount: sql`${blueskyFeeds.deliveredCount} + 1`,
    })
    .where(eq(blueskyFeeds.id, id))
    .run();
}

/** Refreshes the stored name/avatar of every feed for an account (public profile data). */
export async function refreshFeedProfile(
  did: string,
  profile: { handle: string; displayName: string; avatarUrl: string | null },
): Promise<void> {
  await getDb()
    .update(blueskyFeeds)
    .set({ handle: profile.handle, displayName: profile.displayName, avatarUrl: profile.avatarUrl })
    .where(eq(blueskyFeeds.did, did))
    .run();
}

/**
 * Writes `options.milestone_last` without touching any other option. Re-reads the row first, so a
 * dashboard edit made while the poller was busy isn't overwritten with an older copy.
 */
export async function setFeedMilestone(id: number, milestoneLast: number): Promise<void> {
  const row = await getDb().select().from(blueskyFeeds).where(eq(blueskyFeeds.id, id)).get();
  if (!row) return;
  const options = { ...mapRow(row).options, milestone_last: milestoneLast };
  await getDb().update(blueskyFeeds).set({ options: JSON.stringify(options) }).where(eq(blueskyFeeds.id, id)).run();
}

export async function deleteFeed(guildId: string, id: number): Promise<BlueskyFeedRow | null> {
  const row = await getDb()
    .delete(blueskyFeeds)
    .where(and(eq(blueskyFeeds.guildId, guildId), eq(blueskyFeeds.id, id)))
    .returning()
    .get();
  return row ? mapRow(row) : null;
}

// ---------------------------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------------------------

/**
 * Reserves the delivery row *before* the message is sent, so its id can go into the card's button
 * custom IDs. Returns null if the (feed, post) pair was already delivered. Call
 * `completeDelivery` with the sent message id, or `deleteDelivery` if sending failed.
 */
export async function reserveDelivery(input: {
  feedId: number | null;
  guildId: string;
  channelId: string;
  postUri: string;
  postCid: string;
}): Promise<number | null> {
  const row = await getDb()
    .insert(blueskyDeliveries)
    .values({ ...input, messageId: "", createdAt: new Date() })
    .onConflictDoNothing()
    .returning({ id: blueskyDeliveries.id })
    .get();
  return row?.id ?? null;
}

export async function completeDelivery(id: number, messageId: string): Promise<void> {
  await getDb().update(blueskyDeliveries).set({ messageId }).where(eq(blueskyDeliveries.id, id)).run();
}

export async function deleteDelivery(id: number): Promise<void> {
  await getDb().delete(blueskyDeliveries).where(eq(blueskyDeliveries.id, id)).run();
}

export async function getDelivery(id: number): Promise<BlueskyDeliveryRow | null> {
  return (await getDb().select().from(blueskyDeliveries).where(eq(blueskyDeliveries.id, id)).get()) ?? null;
}

/** Net Like / Repost presses from Discord on one card. Never goes below zero. */
export async function adjustDeliveryCounter(id: number, kind: "like" | "repost", delta: 1 | -1): Promise<void> {
  const column = kind === "like" ? blueskyDeliveries.likeCount : blueskyDeliveries.repostCount;
  await getDb()
    .update(blueskyDeliveries)
    .set(kind === "like" ? { likeCount: sql`max(0, ${column} + ${delta})` } : { repostCount: sql`max(0, ${column} + ${delta})` })
    .where(eq(blueskyDeliveries.id, id))
    .run();
}

export async function getDeliveryByMessage(messageId: string): Promise<BlueskyDeliveryRow | null> {
  return (await getDb().select().from(blueskyDeliveries).where(eq(blueskyDeliveries.messageId, messageId)).get()) ?? null;
}

/** Cards older than this stop resolving their buttons/reactions; the post link on them still works. */
export const DELIVERY_RETENTION_MS = 180 * 24 * 60 * 60_000;

export async function pruneDeliveries(): Promise<void> {
  const cutoff = new Date(Date.now() - DELIVERY_RETENTION_MS);
  await getDb().delete(blueskyDeliveries).where(lt(blueskyDeliveries.createdAt, cutoff)).run();
}

// ---------------------------------------------------------------------------------------------
// Dashboard stats
// ---------------------------------------------------------------------------------------------

export const STATS_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;

export type BlueskyFeedStats = {
  /** Posts delivered in the last 30 days. */
  delivered30d: number;
  /** All-time posts delivered (kept on the feed itself). */
  deliveredAll: number;
  /** Net Like / Repost presses from Discord, over the cards still on record (180 days). */
  likes: number;
  reposts: number;
  /** Deliveries per day, oldest first, `STATS_DAYS` entries ending today. */
  daily: number[];
};

/** Index of the day bucket a delivery falls in: 0 = the oldest day, STATS_DAYS - 1 = the last 24 hours. */
export function dayBucket(createdAtMs: number, nowMs: number): number | null {
  const age = Math.floor((nowMs - createdAtMs) / DAY_MS);
  if (age < 0 || age >= STATS_DAYS) return age < 0 ? STATS_DAYS - 1 : null;
  return STATS_DAYS - 1 - age;
}

/** Per-feed stats for one server, keyed by feed id. Two grouped queries, whatever the feed count. */
export async function guildFeedStats(guildId: string, feeds: Pick<BlueskyFeedRow, "id" | "deliveredCount">[]): Promise<Map<number, BlueskyFeedStats>> {
  const now = Date.now();
  const since = new Date(now - STATS_DAYS * DAY_MS);
  const db = getDb();
  const stats = new Map<number, BlueskyFeedStats>();
  for (const feed of feeds) {
    stats.set(feed.id, { delivered30d: 0, deliveredAll: feed.deliveredCount, likes: 0, reposts: 0, daily: Array<number>(STATS_DAYS).fill(0) });
  }

  const recent = await db
    .select({ feedId: blueskyDeliveries.feedId, createdAt: blueskyDeliveries.createdAt })
    .from(blueskyDeliveries)
    .where(and(eq(blueskyDeliveries.guildId, guildId), isNotNull(blueskyDeliveries.feedId), gte(blueskyDeliveries.createdAt, since)))
    .all();
  for (const row of recent) {
    const entry = row.feedId !== null ? stats.get(row.feedId) : undefined;
    if (!entry) continue;
    const bucket = dayBucket(row.createdAt.getTime(), now);
    if (bucket === null) continue;
    entry.daily[bucket]! += 1;
    entry.delivered30d += 1;
  }

  const presses = await db
    .select({
      feedId: blueskyDeliveries.feedId,
      likes: sql<number>`coalesce(sum(${blueskyDeliveries.likeCount}), 0)`,
      reposts: sql<number>`coalesce(sum(${blueskyDeliveries.repostCount}), 0)`,
    })
    .from(blueskyDeliveries)
    .where(and(eq(blueskyDeliveries.guildId, guildId), isNotNull(blueskyDeliveries.feedId)))
    .groupBy(blueskyDeliveries.feedId)
    .all();
  for (const row of presses) {
    const entry = row.feedId !== null ? stats.get(row.feedId) : undefined;
    if (!entry) continue;
    entry.likes = Number(row.likes);
    entry.reposts = Number(row.reposts);
  }
  return stats;
}

/** The server's newest feed deliveries (not pasted-link cards or tests). */
export async function recentGuildDeliveries(guildId: string, limit = 8): Promise<BlueskyDeliveryRow[]> {
  return getDb()
    .select()
    .from(blueskyDeliveries)
    .where(and(eq(blueskyDeliveries.guildId, guildId), isNotNull(blueskyDeliveries.feedId)))
    .orderBy(desc(blueskyDeliveries.createdAt), desc(blueskyDeliveries.id))
    .limit(limit)
    .all();
}
