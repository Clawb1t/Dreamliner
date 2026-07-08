import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { channelAutodelete } from "../../../db/schema.js";

export type AutodeleteRow = {
  guildId: string;
  channelId: string;
  delaySeconds: number;
};

export async function getAutodeleteRule(guildId: string, channelId: string): Promise<AutodeleteRow | null> {
  const row = await getDb()
    .select()
    .from(channelAutodelete)
    .where(and(eq(channelAutodelete.guildId, guildId), eq(channelAutodelete.channelId, channelId)))
    .get();
  return row ?? null;
}

export async function setAutodeleteRule(guildId: string, channelId: string, delaySeconds: number): Promise<void> {
  await getDb()
    .insert(channelAutodelete)
    .values({ guildId, channelId, delaySeconds })
    .onConflictDoUpdate({
      target: [channelAutodelete.guildId, channelAutodelete.channelId],
      set: { delaySeconds },
    });
}

export async function clearAutodeleteRule(guildId: string, channelId: string): Promise<boolean> {
  const result = await getDb()
    .delete(channelAutodelete)
    .where(and(eq(channelAutodelete.guildId, guildId), eq(channelAutodelete.channelId, channelId)))
    .returning()
    .get();
  return Boolean(result);
}
