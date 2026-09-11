import type { Message } from "discord.js";

/**
 * The last deleted message per channel, purely for /snipe. Deliberately separate from the logs
 * plugin's own message store (core/logging/messageStore.js) — that one only captures anything
 * when a server has message logging configured, and /snipe needs to work out of the box in any
 * server regardless of logging setup. In-memory and intentionally short-lived: a bot restart
 * clearing it is fine, this is a lightweight convenience command, not a moderation record.
 *
 * Keyed by channel, not by message, so this map self-bounds at "one entry per channel that's
 * ever had a message deleted" — no sweep/cleanup needed, a later deletion in the same channel
 * just overwrites the previous entry.
 */
export type SnipedMessage = {
  authorId: string;
  authorTag: string;
  authorAvatarUrl: string | null;
  content: string;
  attachmentUrls: string[];
  deletedAt: number;
};

export const SNIPE_WINDOW_MS = 5 * 60_000;

const lastDeletedByChannel = new Map<string, SnipedMessage>();

/** Called from the utility plugin's MessageDelete listener. Only records messages discord.js
 *  already had fully cached (non-partial) — a partial carries no content, and there's no
 *  authorless snapshot worth showing for /snipe. */
export function recordDeletedMessage(message: Message): void {
  if (!message.guild || message.partial || message.author.bot) return;

  lastDeletedByChannel.set(message.channelId, {
    authorId: message.author.id,
    authorTag: message.author.tag,
    authorAvatarUrl: message.author.displayAvatarURL({ size: 128 }),
    content: message.content,
    attachmentUrls: [...message.attachments.values()].map((a) => a.url),
    deletedAt: Date.now(),
  });
}

export type SnipeResult =
  | { found: true; message: SnipedMessage }
  | { found: false; lastDeletedAt?: number };

/** Nothing (`found: false`, no `lastDeletedAt`) if no message has ever been deleted in this
 *  channel since the bot last started. Still `found: false` but with `lastDeletedAt` set if
 *  the most recent deletion here is older than the snipe window. */
export function getSnipe(channelId: string): SnipeResult {
  const entry = lastDeletedByChannel.get(channelId);
  if (!entry) return { found: false };
  if (Date.now() - entry.deletedAt > SNIPE_WINDOW_MS) {
    return { found: false, lastDeletedAt: entry.deletedAt };
  }
  return { found: true, message: entry };
}
