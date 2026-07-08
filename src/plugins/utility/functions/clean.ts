import { randomUUID } from "node:crypto";
import type { Collection, Message, TextChannel } from "discord.js";
import { getDb } from "../../../db/client.js";
import { messageArchives } from "../../../db/schema.js";
import type { ArchivedMessage } from "../../../core/types.js";

export type CleanFilters = {
  userId?: string;
  channelId?: string;
  botsOnly?: boolean;
  pinsOnly?: boolean;
  containsInvite?: boolean;
  regex?: string;
  limit?: number;
  beforeMessageId?: string;
};

const INVITE_REGEX = /(discord\.gg|discord\.com\/invite)\/[a-zA-Z0-9-]+/i;

export async function collectMessagesForClean(
  channel: TextChannel,
  filters: CleanFilters,
): Promise<Collection<string, Message>> {
  const limit = Math.min(filters.limit ?? 100, 100);
  const messages = await channel.messages.fetch({ limit, before: filters.beforeMessageId });

  let filtered = [...messages.values()];

  if (filters.userId) {
    filtered = filtered.filter((m) => m.author.id === filters.userId);
  }
  if (filters.botsOnly) {
    filtered = filtered.filter((m) => m.author.bot);
  }
  if (filters.pinsOnly) {
    filtered = filtered.filter((m) => m.pinned);
  }
  if (filters.containsInvite) {
    filtered = filtered.filter((m) => INVITE_REGEX.test(m.content));
  }
  if (filters.regex) {
    try {
      const re = new RegExp(filters.regex, "i");
      filtered = filtered.filter((m) => re.test(m.content));
    } catch {
      // invalid regex - no additional filter
    }
  }

  const result = messages.filter((m) => filtered.some((f) => f.id === m.id));
  return result;
}

export function serializeMessages(messages: Message[]): ArchivedMessage[] {
  return messages.map((m) => ({
    id: m.id,
    authorId: m.author.id,
    authorTag: m.author.tag,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    attachments: [...m.attachments.values()].map((a) => a.url),
  }));
}

export async function archiveMessages(guildId: string, messages: ArchivedMessage[]): Promise<string> {
  const id = randomUUID();
  const db = getDb();
  await db.insert(messageArchives).values({
    id,
    guildId,
    createdAt: new Date(),
    payload: JSON.stringify(messages),
  });
  return id;
}

export async function getArchivePayload(id: string): Promise<ArchivedMessage[] | null> {
  const db = getDb();
  const { eq } = await import("drizzle-orm");
  const row = await db.select().from(messageArchives).where(eq(messageArchives.id, id)).get();
  if (!row) return null;
  return JSON.parse(row.payload) as ArchivedMessage[];
}

export async function archiveSingleMessage(guildId: string, message: Message): Promise<string> {
  return archiveMessages(guildId, serializeMessages([message]));
}
