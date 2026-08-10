import type { Client, MessageReaction } from "discord.js";

export function normalizeEmojiInput(emoji: string): string {
  const trimmed = emoji.trim();
  const customMatch = trimmed.match(/^<(a?):(\w+):(\d+)>$/);
  if (customMatch) {
    const animated = customMatch[1] === "a";
    return `<${animated ? "a" : ""}:${customMatch[2]}:${customMatch[3]}>`;
  }
  return trimmed;
}

/**
 * Expand a bare custom-emoji snowflake to `<:name:id>` for message content.
 * Unicode and already-formatted mentions are returned unchanged.
 */
export function resolveEmojiForContent(raw: string, client?: Client | null): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (/^<a?:\w+:\d{5,20}>$/.test(trimmed)) return trimmed;
  if (/^\d{5,20}$/.test(trimmed) && client) {
    const emoji = client.emojis.cache.get(trimmed);
    if (emoji) return emoji.toString();
  }
  return trimmed;
}

/** Parse a configured emoji into a discord.js button/reaction emoji value. */
export function parseComponentEmoji(
  raw: string,
): string | { id: string; name?: string; animated?: boolean } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const mention = trimmed.match(/^<(a?):([A-Za-z0-9_]+):(\d{5,20})>$/);
  if (mention) {
    return {
      id: mention[3]!,
      name: mention[2],
      animated: mention[1] === "a",
    };
  }
  if (/^\d{5,20}$/.test(trimmed)) {
    return { id: trimmed };
  }
  return trimmed;
}

export function normalizeReactionEmoji(emoji: MessageReaction["emoji"]): string {
  return emoji.toString();
}

export function emojiKeysMatch(stored: string, reaction: MessageReaction["emoji"]): boolean {
  const normalizedStored = normalizeEmojiInput(stored);
  const reactionString = reaction.toString();
  if (normalizedStored === reactionString) return true;

  const id = reaction.id;
  const name = reaction.name ?? "";
  if (!id && normalizedStored === name) return true;

  const customMatch = normalizedStored.match(/^<a?:([^:]+):(\d+)>$/);
  if (customMatch && id === customMatch[2]) return true;

  return false;
}
