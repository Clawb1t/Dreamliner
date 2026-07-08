import { and, eq, like } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { companionChannels } from "../../../db/schema.js";
import { HUB_OWNER_PREFIX, hubOwnerId, isHubOwnerId } from "../defaultOverrides.js";

export type CompanionChannelRow = {
  guildId: string;
  ownerId: string;
  channelId: string;
};

export async function registerHub(guildId: string, hubChannelId: string): Promise<void> {
  await getDb()
    .insert(companionChannels)
    .values({
      guildId,
      ownerId: hubOwnerId(hubChannelId),
      channelId: hubChannelId,
    })
    .onConflictDoUpdate({
      target: [companionChannels.guildId, companionChannels.ownerId],
      set: { channelId: hubChannelId },
    });
}

export async function unregisterHub(guildId: string, hubChannelId: string): Promise<boolean> {
  const result = await getDb()
    .delete(companionChannels)
    .where(and(eq(companionChannels.guildId, guildId), eq(companionChannels.ownerId, hubOwnerId(hubChannelId))))
    .returning()
    .get();
  return Boolean(result);
}

export async function isHubChannel(guildId: string, channelId: string): Promise<boolean> {
  const row = await getDb()
    .select()
    .from(companionChannels)
    .where(and(eq(companionChannels.guildId, guildId), eq(companionChannels.ownerId, hubOwnerId(channelId))))
    .get();
  return Boolean(row);
}

export async function listHubs(guildId: string): Promise<CompanionChannelRow[]> {
  return getDb()
    .select()
    .from(companionChannels)
    .where(and(eq(companionChannels.guildId, guildId), like(companionChannels.ownerId, `${HUB_OWNER_PREFIX}%`)))
    .all();
}

export async function getUserCompanion(guildId: string, ownerId: string): Promise<CompanionChannelRow | null> {
  if (isHubOwnerId(ownerId)) return null;
  const row = await getDb()
    .select()
    .from(companionChannels)
    .where(and(eq(companionChannels.guildId, guildId), eq(companionChannels.ownerId, ownerId)))
    .get();
  return row ?? null;
}

export async function setUserCompanion(guildId: string, ownerId: string, channelId: string): Promise<void> {
  await getDb()
    .insert(companionChannels)
    .values({ guildId, ownerId, channelId })
    .onConflictDoUpdate({
      target: [companionChannels.guildId, companionChannels.ownerId],
      set: { channelId },
    });
}

export async function removeUserCompanion(guildId: string, ownerId: string): Promise<void> {
  await getDb()
    .delete(companionChannels)
    .where(and(eq(companionChannels.guildId, guildId), eq(companionChannels.ownerId, ownerId)));
}

export async function getCompanionByChannelId(guildId: string, channelId: string): Promise<CompanionChannelRow | null> {
  const rows = await getDb().select().from(companionChannels).where(eq(companionChannels.guildId, guildId)).all();
  return rows.find((row) => !isHubOwnerId(row.ownerId) && row.channelId === channelId) ?? null;
}
