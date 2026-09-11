import { randomUUID } from "node:crypto";
import type { Collection, Message, TextChannel } from "discord.js";
import { compileUserRegex } from "../../../core/userRegex.js";
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
    const re = compileUserRegex(filters.regex);
    if (re) {
      filtered = filtered.filter((m) => re.test(m.content));
    }
  }

  const result = messages.filter((m) => filtered.some((f) => f.id === m.id));
  return result;
}

export type CleanToHereResult = {
  messages: Collection<string, Message>;
  /** True when there were more than 100 messages between the target and now — Discord's
   *  bulk-delete API caps a single call at 100, so anything beyond that would be left behind. */
  truncated: boolean;
};

/**
 * Every message from `targetMessageId` through to the newest message in the channel — for the
 * "Clean to here" message context command. Discord's bulk-delete API caps a single call at 100
 * messages, so this fetches the 100 *newest* messages in the channel (favoring the freshest
 * ones — whatever's actually driving the cleanup — over the oldest) and keeps whichever of
 * those are at or after the target, always including the target itself even if it fell outside
 * that window.
 */
export async function collectMessagesToHere(
  channel: TextChannel,
  targetMessageId: string,
): Promise<CleanToHereResult | null> {
  const target = await channel.messages.fetch(targetMessageId).catch(() => null);
  if (!target) return null;

  const recent = await channel.messages.fetch({ limit: 100 });
  const targetIdNum = BigInt(target.id);
  let inRange = recent.filter((m) => BigInt(m.id) >= targetIdNum);

  // Every one of the 100 newest messages is already at or after the target — the true range
  // reaches further back than this fetch can see, so there's a gap between the oldest message
  // here and the target that this pass can't reach.
  const truncated = recent.size === 100 && inRange.size === recent.size;

  if (!inRange.has(target.id)) inRange = inRange.set(target.id, target);
  inRange = inRange.filter((m) => !m.pinned);

  return { messages: inRange, truncated };
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

/**
 * A plain-text transcript of an archive — oldest first, regardless of the order messages were
 * fetched/deleted in — attached as a real file to both the command's own response and the mod
 * log message, instead of leaving people to look a bare archive ID up later.
 */
export function formatArchiveTranscript(messages: ArchivedMessage[]): string {
  return [...messages]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((m) => {
      const content = m.content?.trim() ? m.content : "(no text content)";
      const attachments = m.attachments.length ? `\n  Attachments: ${m.attachments.join(", ")}` : "";
      return `[${m.createdAt}] ${m.authorTag} (${m.authorId}):\n  ${content}${attachments}`;
    })
    .join("\n\n");
}

export async function archiveMessages(guildId: string, messages: ArchivedMessage[]): Promise<string> {
  const id = randomUUID();
  const db = getDb();
  // Content is stored as-is here; `sweepMessageArchives` redacts it once it ages past
  // this guild's content-retention setting.
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
