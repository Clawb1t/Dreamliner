import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { socialYoutubeWatchers } from "../../../db/schema.js";
import type { SocialEmbedConfig } from "../../../config/schemas/social.js";

export type SocialWatcherRow = {
  id: number;
  guildId: string;
  discordChannelId: string;
  sourceChannelId: string;
  sourceChannelHandle: string | null;
  sourceChannelName: string;
  sourceChannelAvatarUrl: string | null;
  sourceChannelUrl: string;
  uploadsPlaylistId: string;
  messageContent: string;
  mentionRoleIds: string[];
  embedConfig: SocialEmbedConfig;
  lastVideoId: string | null;
  lastVideoPublishedAt: Date | null;
  lastCheckedAt: Date | null;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Free-tier cap. Dreamliner One servers get ONE_WATCHERS_LIMIT instead (see resolveMaxWatchers). */
export const FREE_WATCHERS_LIMIT = 10;
export const ONE_WATCHERS_LIMIT = 50;

export function resolveMaxWatchers(oneActive: boolean): number {
  return oneActive ? ONE_WATCHERS_LIMIT : FREE_WATCHERS_LIMIT;
}

function mapRow(row: typeof socialYoutubeWatchers.$inferSelect): SocialWatcherRow {
  let mentionRoleIds: string[] = [];
  try {
    const parsed = JSON.parse(row.mentionRoleIds) as unknown;
    if (Array.isArray(parsed)) mentionRoleIds = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    mentionRoleIds = [];
  }
  return {
    id: row.id,
    guildId: row.guildId,
    discordChannelId: row.discordChannelId,
    sourceChannelId: row.sourceChannelId,
    sourceChannelHandle: row.sourceChannelHandle,
    sourceChannelName: row.sourceChannelName,
    sourceChannelAvatarUrl: row.sourceChannelAvatarUrl,
    sourceChannelUrl: row.sourceChannelUrl,
    uploadsPlaylistId: row.uploadsPlaylistId,
    messageContent: row.messageContent,
    mentionRoleIds,
    embedConfig: JSON.parse(row.embedConfig) as SocialEmbedConfig,
    lastVideoId: row.lastVideoId,
    lastVideoPublishedAt: row.lastVideoPublishedAt,
    lastCheckedAt: row.lastCheckedAt,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listWatchers(guildId: string): Promise<SocialWatcherRow[]> {
  const rows = await getDb()
    .select()
    .from(socialYoutubeWatchers)
    .where(eq(socialYoutubeWatchers.guildId, guildId))
    .all();
  return rows.map(mapRow);
}

/** Cross-guild, used by the poller. */
export async function listAllEnabledWatchers(): Promise<SocialWatcherRow[]> {
  const rows = await getDb()
    .select()
    .from(socialYoutubeWatchers)
    .where(eq(socialYoutubeWatchers.enabled, true))
    .all();
  return rows.map(mapRow);
}

export async function getWatcher(guildId: string, id: number): Promise<SocialWatcherRow | null> {
  const row = await getDb()
    .select()
    .from(socialYoutubeWatchers)
    .where(and(eq(socialYoutubeWatchers.guildId, guildId), eq(socialYoutubeWatchers.id, id)))
    .get();
  return row ? mapRow(row) : null;
}

export async function countWatchers(guildId: string): Promise<number> {
  const row = await getDb()
    .select({ count: sql<number>`count(*)` })
    .from(socialYoutubeWatchers)
    .where(eq(socialYoutubeWatchers.guildId, guildId))
    .get();
  return Number(row?.count ?? 0);
}

export async function createWatcher(input: {
  guildId: string;
  discordChannelId: string;
  sourceChannelId: string;
  sourceChannelHandle: string | null;
  sourceChannelName: string;
  sourceChannelAvatarUrl: string | null;
  sourceChannelUrl: string;
  uploadsPlaylistId: string;
  messageContent: string;
  mentionRoleIds: string[];
  embedConfig: SocialEmbedConfig;
  lastVideoId: string | null;
  lastVideoPublishedAt: Date | null;
  createdBy: string;
}): Promise<SocialWatcherRow> {
  const now = new Date();
  const row = await getDb()
    .insert(socialYoutubeWatchers)
    .values({
      guildId: input.guildId,
      discordChannelId: input.discordChannelId,
      sourceChannelId: input.sourceChannelId,
      sourceChannelHandle: input.sourceChannelHandle,
      sourceChannelName: input.sourceChannelName,
      sourceChannelAvatarUrl: input.sourceChannelAvatarUrl,
      sourceChannelUrl: input.sourceChannelUrl,
      uploadsPlaylistId: input.uploadsPlaylistId,
      messageContent: input.messageContent,
      mentionRoleIds: JSON.stringify(input.mentionRoleIds),
      embedConfig: JSON.stringify(input.embedConfig),
      lastVideoId: input.lastVideoId,
      lastVideoPublishedAt: input.lastVideoPublishedAt,
      lastCheckedAt: null,
      enabled: true,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return mapRow(row);
}

export async function updateWatcher(
  guildId: string,
  id: number,
  patch: {
    discordChannelId?: string;
    messageContent?: string;
    mentionRoleIds?: string[];
    embedConfig?: SocialEmbedConfig;
    enabled?: boolean;
  },
): Promise<SocialWatcherRow | null> {
  const row = await getDb()
    .update(socialYoutubeWatchers)
    .set({
      ...(patch.discordChannelId !== undefined ? { discordChannelId: patch.discordChannelId } : {}),
      ...(patch.messageContent !== undefined ? { messageContent: patch.messageContent } : {}),
      ...(patch.mentionRoleIds !== undefined ? { mentionRoleIds: JSON.stringify(patch.mentionRoleIds) } : {}),
      ...(patch.embedConfig !== undefined ? { embedConfig: JSON.stringify(patch.embedConfig) } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(socialYoutubeWatchers.guildId, guildId), eq(socialYoutubeWatchers.id, id)))
    .returning()
    .get();
  return row ? mapRow(row) : null;
}

export async function updateCheckpoint(
  id: number,
  patch: { lastVideoId: string | null; lastVideoPublishedAt: Date | null },
): Promise<void> {
  await getDb()
    .update(socialYoutubeWatchers)
    .set({
      lastVideoId: patch.lastVideoId,
      lastVideoPublishedAt: patch.lastVideoPublishedAt,
      lastCheckedAt: new Date(),
    })
    .where(eq(socialYoutubeWatchers.id, id))
    .run();
}

export async function touchLastChecked(id: number): Promise<void> {
  await getDb()
    .update(socialYoutubeWatchers)
    .set({ lastCheckedAt: new Date() })
    .where(eq(socialYoutubeWatchers.id, id))
    .run();
}

export async function deleteWatcher(guildId: string, id: number): Promise<SocialWatcherRow | null> {
  const row = await getDb()
    .delete(socialYoutubeWatchers)
    .where(and(eq(socialYoutubeWatchers.guildId, guildId), eq(socialYoutubeWatchers.id, id)))
    .returning()
    .get();
  return row ? mapRow(row) : null;
}
