import { and, eq, lte } from "drizzle-orm";
import type { Message, PartialMessage } from "discord.js";
import { getDb } from "../../db/client.js";
import { logMessages } from "../../db/schema.js";

const RETENTION_MS = 42 * 24 * 60 * 60 * 1000;

export type StoredLogMessage = {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  channelName: string | null;
  content: string;
};

function channelNameFrom(message: Message | PartialMessage): string | null {
  if (message.channel.isTextBased() && "name" in message.channel && message.channel.name) {
    return message.channel.name;
  }
  return null;
}

export async function upsertLogMessage(message: Message | PartialMessage): Promise<void> {
  if (!message.guild || !message.author || message.author.bot) return;

  const db = getDb();
  const now = new Date();
  await db
    .insert(logMessages)
    .values({
      guildId: message.guild.id,
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.author.id,
      authorName: message.author.username,
      channelName: channelNameFrom(message),
      content: message.content ?? "",
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [logMessages.guildId, logMessages.channelId, logMessages.messageId],
      set: {
        authorId: message.author.id,
        authorName: message.author.username,
        channelName: channelNameFrom(message),
        content: message.content ?? "",
        updatedAt: now,
      },
    });

  await pruneOldLogMessages(message.guild.id);
}

export async function getLogMessage(
  guildId: string,
  channelId: string,
  messageId: string,
): Promise<StoredLogMessage | null> {
  const db = getDb();
  const row = await db
    .select()
    .from(logMessages)
    .where(
      and(
        eq(logMessages.guildId, guildId),
        eq(logMessages.channelId, channelId),
        eq(logMessages.messageId, messageId),
      ),
    )
    .get();
  if (!row) return null;
  return {
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    authorId: row.authorId,
    authorName: row.authorName,
    channelName: row.channelName,
    content: row.content,
  };
}

export async function deleteLogMessage(guildId: string, channelId: string, messageId: string): Promise<void> {
  const db = getDb();
  await db
    .delete(logMessages)
    .where(
      and(
        eq(logMessages.guildId, guildId),
        eq(logMessages.channelId, channelId),
        eq(logMessages.messageId, messageId),
      ),
    );
}

async function pruneOldLogMessages(guildId: string): Promise<void> {
  const db = getDb();
  const cutoff = new Date(Date.now() - RETENTION_MS);
  await db.delete(logMessages).where(and(eq(logMessages.guildId, guildId), lte(logMessages.updatedAt, cutoff)));
}
