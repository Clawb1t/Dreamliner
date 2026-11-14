/**
 * The `social_deliveries` log: one row per notification the bot sent (tests and milestone cards
 * aren't logged). Backs the dashboard's per-creator stats and recent list, and for Twitch it is
 * how a live session finds its message again (live title updates, stream-ended edits).
 */
import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { socialDeliveries, socialTwitchWatchers, socialYoutubeWatchers } from "../../../db/schema.js";

export type SocialPlatform = "youtube" | "twitch";
export type SocialDeliveryRow = typeof socialDeliveries.$inferSelect;

export const STATS_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
/** Deliveries older than this are pruned; the all-time counter lives on the watcher row. */
export const DELIVERY_RETENTION_MS = 180 * DAY_MS;

export async function recordDelivery(input: {
  platform: SocialPlatform;
  watcherId: number;
  guildId: string;
  channelId: string;
  messageId: string | null;
  kind: string;
  itemId: string;
  title: string;
  url: string;
  thumbnailUrl: string | null;
  gameName?: string | null;
  peakViewers?: number;
  startedAt?: Date | null;
}): Promise<SocialDeliveryRow> {
  const db = getDb();
  const row = await db
    .insert(socialDeliveries)
    .values({
      platform: input.platform,
      watcherId: input.watcherId,
      guildId: input.guildId,
      channelId: input.channelId,
      messageId: input.messageId,
      kind: input.kind,
      itemId: input.itemId,
      title: input.title.slice(0, 300),
      url: input.url.slice(0, 500),
      thumbnailUrl: input.thumbnailUrl,
      gameName: input.gameName ?? null,
      peakViewers: input.peakViewers ?? 0,
      startedAt: input.startedAt ?? null,
      endedAt: null,
      createdAt: new Date(),
    })
    .returning()
    .get();
  const table = input.platform === "youtube" ? socialYoutubeWatchers : socialTwitchWatchers;
  await db
    .update(table)
    .set({ deliveredCount: sql`${table.deliveredCount} + 1` })
    .where(eq(table.id, input.watcherId))
    .run();
  return row;
}

/** The newest delivery for a watcher (any session), e.g. for the YouTube ping cooldown. */
export async function latestDelivery(platform: SocialPlatform, watcherId: number): Promise<SocialDeliveryRow | null> {
  return (
    (await getDb()
      .select()
      .from(socialDeliveries)
      .where(and(eq(socialDeliveries.platform, platform), eq(socialDeliveries.watcherId, watcherId)))
      .orderBy(desc(socialDeliveries.createdAt), desc(socialDeliveries.id))
      .limit(1)
      .get()) ?? null
  );
}

/** The Twitch session still waiting for its stream-ended handling, if any. */
export async function openTwitchSession(watcherId: number): Promise<SocialDeliveryRow | null> {
  return (
    (await getDb()
      .select()
      .from(socialDeliveries)
      .where(and(eq(socialDeliveries.platform, "twitch"), eq(socialDeliveries.watcherId, watcherId), isNull(socialDeliveries.endedAt)))
      .orderBy(desc(socialDeliveries.createdAt), desc(socialDeliveries.id))
      .limit(1)
      .get()) ?? null
  );
}

export async function updateDelivery(
  id: number,
  patch: Partial<Pick<SocialDeliveryRow, "itemId" | "title" | "gameName" | "peakViewers" | "endedAt" | "thumbnailUrl" | "messageId">>,
): Promise<void> {
  if (!Object.keys(patch).length) return;
  await getDb().update(socialDeliveries).set(patch).where(eq(socialDeliveries.id, id)).run();
}

export async function deleteWatcherDeliveries(platform: SocialPlatform, watcherId: number): Promise<void> {
  await getDb()
    .delete(socialDeliveries)
    .where(and(eq(socialDeliveries.platform, platform), eq(socialDeliveries.watcherId, watcherId)))
    .run();
}

export async function pruneSocialDeliveries(): Promise<void> {
  const cutoff = new Date(Date.now() - DELIVERY_RETENTION_MS);
  await getDb().delete(socialDeliveries).where(lt(socialDeliveries.createdAt, cutoff)).run();
}

// ---------------------------------------------------------------------------------------------
// Dashboard stats
// ---------------------------------------------------------------------------------------------

export type SocialWatcherStats = {
  delivered30d: number;
  deliveredAll: number;
  /** Notifications per day, oldest first, STATS_DAYS entries ending today. */
  daily: number[];
  lastNotifiedAt: string | null;
};

/** Index of the day bucket: 0 = the oldest day, STATS_DAYS - 1 = the last 24 hours. */
export function dayBucket(createdAtMs: number, nowMs: number): number | null {
  const age = Math.floor((nowMs - createdAtMs) / DAY_MS);
  if (age < 0) return STATS_DAYS - 1;
  if (age >= STATS_DAYS) return null;
  return STATS_DAYS - 1 - age;
}

export function statsKey(platform: SocialPlatform, id: number): string {
  return `${platform}:${id}`;
}

/** Per-watcher stats for one server, keyed by `platform:id`. Two queries, whatever the watcher count. */
export async function guildSocialStats(
  guildId: string,
  watchers: { platform: SocialPlatform; id: number; deliveredCount: number }[],
): Promise<Map<string, SocialWatcherStats>> {
  const now = Date.now();
  const db = getDb();
  const stats = new Map<string, SocialWatcherStats>();
  for (const w of watchers) {
    stats.set(statsKey(w.platform, w.id), {
      delivered30d: 0,
      deliveredAll: w.deliveredCount,
      daily: Array<number>(STATS_DAYS).fill(0),
      lastNotifiedAt: null,
    });
  }
  const recent = await db
    .select({ platform: socialDeliveries.platform, watcherId: socialDeliveries.watcherId, createdAt: socialDeliveries.createdAt })
    .from(socialDeliveries)
    .where(and(eq(socialDeliveries.guildId, guildId), gte(socialDeliveries.createdAt, new Date(now - STATS_DAYS * DAY_MS))))
    .all();
  for (const row of recent) {
    const entry = stats.get(statsKey(row.platform as SocialPlatform, row.watcherId));
    if (!entry) continue;
    const bucket = dayBucket(row.createdAt.getTime(), now);
    if (bucket === null) continue;
    entry.daily[bucket]! += 1;
    entry.delivered30d += 1;
  }
  const last = await db
    .select({
      platform: socialDeliveries.platform,
      watcherId: socialDeliveries.watcherId,
      at: sql<number>`max(${socialDeliveries.createdAt})`,
    })
    .from(socialDeliveries)
    .where(eq(socialDeliveries.guildId, guildId))
    .groupBy(socialDeliveries.platform, socialDeliveries.watcherId)
    .all();
  for (const row of last) {
    const entry = stats.get(statsKey(row.platform as SocialPlatform, row.watcherId));
    // Timestamps are stored as unix seconds.
    if (entry && row.at) entry.lastNotifiedAt = new Date(Number(row.at) * 1000).toISOString();
  }
  return stats;
}

export async function recentGuildSocialDeliveries(guildId: string, limit = 10): Promise<SocialDeliveryRow[]> {
  return getDb()
    .select()
    .from(socialDeliveries)
    .where(eq(socialDeliveries.guildId, guildId))
    .orderBy(desc(socialDeliveries.createdAt), desc(socialDeliveries.id))
    .limit(limit)
    .all();
}
