import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { socialTwitchWatchers } from "../../../db/schema.js";
import type { SocialEmbedConfig } from "../../../config/schemas/social.js";

export type SocialTwitchWatcherRow = {
  id: number;
  guildId: string;
  discordChannelId: string;
  sourceUserId: string;
  sourceUserLogin: string;
  sourceUserDisplayName: string;
  sourceUserAvatarUrl: string | null;
  sourceUserUrl: string;
  messageContent: string;
  mentionRoleIds: string[];
  embedConfig: SocialEmbedConfig;
  lastStreamId: string | null;
  lastLiveAt: Date | null;
  lastCheckedAt: Date | null;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

function mapRow(row: typeof socialTwitchWatchers.$inferSelect): SocialTwitchWatcherRow {
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
    sourceUserId: row.sourceUserId,
    sourceUserLogin: row.sourceUserLogin,
    sourceUserDisplayName: row.sourceUserDisplayName,
    sourceUserAvatarUrl: row.sourceUserAvatarUrl,
    sourceUserUrl: row.sourceUserUrl,
    messageContent: row.messageContent,
    mentionRoleIds,
    embedConfig: JSON.parse(row.embedConfig) as SocialEmbedConfig,
    lastStreamId: row.lastStreamId,
    lastLiveAt: row.lastLiveAt,
    lastCheckedAt: row.lastCheckedAt,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listTwitchWatchers(guildId: string): Promise<SocialTwitchWatcherRow[]> {
  const rows = await getDb().select().from(socialTwitchWatchers).where(eq(socialTwitchWatchers.guildId, guildId)).all();
  return rows.map(mapRow);
}

/** Cross-guild, used by the poller. */
export async function listAllEnabledTwitchWatchers(): Promise<SocialTwitchWatcherRow[]> {
  const rows = await getDb().select().from(socialTwitchWatchers).where(eq(socialTwitchWatchers.enabled, true)).all();
  return rows.map(mapRow);
}

export async function getTwitchWatcher(guildId: string, id: number): Promise<SocialTwitchWatcherRow | null> {
  const row = await getDb()
    .select()
    .from(socialTwitchWatchers)
    .where(and(eq(socialTwitchWatchers.guildId, guildId), eq(socialTwitchWatchers.id, id)))
    .get();
  return row ? mapRow(row) : null;
}

export async function countTwitchWatchers(guildId: string): Promise<number> {
  const row = await getDb()
    .select({ count: sql<number>`count(*)` })
    .from(socialTwitchWatchers)
    .where(eq(socialTwitchWatchers.guildId, guildId))
    .get();
  return Number(row?.count ?? 0);
}

export async function createTwitchWatcher(input: {
  guildId: string;
  discordChannelId: string;
  sourceUserId: string;
  sourceUserLogin: string;
  sourceUserDisplayName: string;
  sourceUserAvatarUrl: string | null;
  sourceUserUrl: string;
  messageContent: string;
  mentionRoleIds: string[];
  embedConfig: SocialEmbedConfig;
  lastStreamId: string | null;
  lastLiveAt: Date | null;
  createdBy: string;
}): Promise<SocialTwitchWatcherRow> {
  const now = new Date();
  const row = await getDb()
    .insert(socialTwitchWatchers)
    .values({
      guildId: input.guildId,
      discordChannelId: input.discordChannelId,
      sourceUserId: input.sourceUserId,
      sourceUserLogin: input.sourceUserLogin,
      sourceUserDisplayName: input.sourceUserDisplayName,
      sourceUserAvatarUrl: input.sourceUserAvatarUrl,
      sourceUserUrl: input.sourceUserUrl,
      messageContent: input.messageContent,
      mentionRoleIds: JSON.stringify(input.mentionRoleIds),
      embedConfig: JSON.stringify(input.embedConfig),
      lastStreamId: input.lastStreamId,
      lastLiveAt: input.lastLiveAt,
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

export async function updateTwitchWatcher(
  guildId: string,
  id: number,
  patch: {
    discordChannelId?: string;
    messageContent?: string;
    mentionRoleIds?: string[];
    embedConfig?: SocialEmbedConfig;
    enabled?: boolean;
  },
): Promise<SocialTwitchWatcherRow | null> {
  const row = await getDb()
    .update(socialTwitchWatchers)
    .set({
      ...(patch.discordChannelId !== undefined ? { discordChannelId: patch.discordChannelId } : {}),
      ...(patch.messageContent !== undefined ? { messageContent: patch.messageContent } : {}),
      ...(patch.mentionRoleIds !== undefined ? { mentionRoleIds: JSON.stringify(patch.mentionRoleIds) } : {}),
      ...(patch.embedConfig !== undefined ? { embedConfig: JSON.stringify(patch.embedConfig) } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(socialTwitchWatchers.guildId, guildId), eq(socialTwitchWatchers.id, id)))
    .returning()
    .get();
  return row ? mapRow(row) : null;
}

export async function updateTwitchCheckpoint(
  id: number,
  patch: { lastStreamId: string | null; lastLiveAt: Date | null },
): Promise<void> {
  await getDb()
    .update(socialTwitchWatchers)
    .set({ lastStreamId: patch.lastStreamId, lastLiveAt: patch.lastLiveAt, lastCheckedAt: new Date() })
    .where(eq(socialTwitchWatchers.id, id))
    .run();
}

export async function touchTwitchLastChecked(id: number): Promise<void> {
  await getDb().update(socialTwitchWatchers).set({ lastCheckedAt: new Date() }).where(eq(socialTwitchWatchers.id, id)).run();
}

export async function deleteTwitchWatcher(guildId: string, id: number): Promise<SocialTwitchWatcherRow | null> {
  const row = await getDb()
    .delete(socialTwitchWatchers)
    .where(and(eq(socialTwitchWatchers.guildId, guildId), eq(socialTwitchWatchers.id, id)))
    .returning()
    .get();
  return row ? mapRow(row) : null;
}
