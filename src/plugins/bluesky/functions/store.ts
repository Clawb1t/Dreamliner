import { and, eq, lt, sql } from "drizzle-orm";
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
    .set({ lastPostAt: new Date(), handle: author.handle, displayName: author.displayName, avatarUrl: author.avatarUrl })
    .where(eq(blueskyFeeds.id, id))
    .run();
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

export async function getDeliveryByMessage(messageId: string): Promise<BlueskyDeliveryRow | null> {
  return (await getDb().select().from(blueskyDeliveries).where(eq(blueskyDeliveries.messageId, messageId)).get()) ?? null;
}

/** Cards older than this stop resolving their buttons/reactions; the post link on them still works. */
export const DELIVERY_RETENTION_MS = 180 * 24 * 60 * 60_000;

export async function pruneDeliveries(): Promise<void> {
  const cutoff = new Date(Date.now() - DELIVERY_RETENTION_MS);
  await getDb().delete(blueskyDeliveries).where(lt(blueskyDeliveries.createdAt, cutoff)).run();
}
