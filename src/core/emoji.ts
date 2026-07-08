import type { MessageReaction } from "discord.js";

export function normalizeEmojiInput(emoji: string): string {
  const trimmed = emoji.trim();
  const customMatch = trimmed.match(/^<(a?):(\w+):(\d+)>$/);
  if (customMatch) {
    const animated = customMatch[1] === "a";
    return `<${animated ? "a" : ""}:${customMatch[2]}:${customMatch[3]}>`;
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
