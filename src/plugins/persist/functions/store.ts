import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { persistedMessages } from "../../../db/schema.js";

export type PersistedMessageRow = {
  guildId: string;
  channelId: string;
  messageId: string;
  content: string;
};

export async function listPersistedMessages(guildId: string): Promise<PersistedMessageRow[]> {
  const rows = await getDb().select().from(persistedMessages).where(eq(persistedMessages.guildId, guildId)).all();
  return rows.map((row) => ({
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    content: row.content,
  }));
}

export async function getPersistedMessage(guildId: string, channelId: string): Promise<PersistedMessageRow | undefined> {
  const row = await getDb()
    .select()
    .from(persistedMessages)
    .where(and(eq(persistedMessages.guildId, guildId), eq(persistedMessages.channelId, channelId)))
    .get();

  if (!row) return undefined;
  return {
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    content: row.content,
  };
}

export async function upsertPersistedMessage(input: {
  guildId: string;
  channelId: string;
  messageId: string;
  content: string;
}): Promise<void> {
  await getDb()
    .insert(persistedMessages)
    .values(input)
    .onConflictDoUpdate({
      target: [persistedMessages.guildId, persistedMessages.channelId],
      set: {
        messageId: input.messageId,
        content: input.content,
      },
    });
}

export async function removePersistedMessage(guildId: string, channelId: string): Promise<boolean> {
  const result = await getDb()
    .delete(persistedMessages)
    .where(and(eq(persistedMessages.guildId, guildId), eq(persistedMessages.channelId, channelId)))
    .returning()
    .get();
  return Boolean(result);
}

export async function updatePersistedMessageId(
  guildId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  await getDb()
    .update(persistedMessages)
    .set({ messageId })
    .where(and(eq(persistedMessages.guildId, guildId), eq(persistedMessages.channelId, channelId)));
}
