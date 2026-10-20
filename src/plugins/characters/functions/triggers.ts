import type { CharactersConfig } from "../../../config/schemas/characters.js";
import { MAX_CHARACTERS_PER_MESSAGE } from "../constants.js";

/**
 * Which characters a member's message is talking to. Pure (works on a plain description of the
 * message), so the Discord listener stays thin and this stays testable.
 */

export type TriggerCharacter = {
  id: number;
  name: string;
  roleId: string | null;
  dedicatedChannelIds: string[];
  allowedChannelIds: string[];
  enabled: boolean;
  reviewStatus: "approved" | "rejected";
};

export type TriggerMessage = {
  authorBot: boolean;
  webhookId: string | null;
  inGuild: boolean;
  /** Discord system messages (joins, boosts, pins...). */
  system: boolean;
  content: string;
  channelId: string;
  /** The thread's parent channel, when the message is in a thread. */
  parentId: string | null;
  /** The category the channel (or the thread's parent) is in. */
  categoryId: string | null;
  nsfw: boolean;
  /** The message this one replies to, when it's a reply. */
  reference: { webhookId: string | null; authorName: string } | null;
};

export type TriggerReason = "mention" | "reply" | "dedicated" | "name";
export type TriggerMatch<C extends TriggerCharacter> = { character: C; reason: TriggerReason };

export type TriggerConfig = Pick<CharactersConfig, "allowed_channels" | "blocked_channels" | "triggers">;

/** Bots, webhooks (other characters included, so they never loop), DMs and system messages. */
export function shouldIgnoreMessage(message: Pick<TriggerMessage, "authorBot" | "webhookId" | "inGuild" | "system">): boolean {
  return message.authorBot || Boolean(message.webhookId) || !message.inGuild || message.system;
}

function scopeIds(message: Pick<TriggerMessage, "channelId" | "parentId" | "categoryId">): string[] {
  return [message.channelId, message.parentId, message.categoryId].filter((id): id is string => Boolean(id));
}

export function isDedicatedChannel(character: TriggerCharacter, message: Pick<TriggerMessage, "channelId" | "parentId">): boolean {
  return (
    character.dedicatedChannelIds.includes(message.channelId) ||
    Boolean(message.parentId && character.dedicatedChannelIds.includes(message.parentId))
  );
}

/**
 * Whether `character` may talk where `message` was sent: never in blocked or age-restricted
 * channels; always in its own dedicated channels; otherwise its own allowed channels, else the
 * plugin-wide ones (empty means everywhere).
 */
export function channelAllowed(
  character: TriggerCharacter,
  message: Pick<TriggerMessage, "channelId" | "parentId" | "categoryId" | "nsfw">,
  config: Pick<CharactersConfig, "allowed_channels" | "blocked_channels">,
): boolean {
  if (message.nsfw) return false;
  const scope = scopeIds(message);
  if (scope.some((id) => config.blocked_channels.includes(id))) return false;
  if (isDedicatedChannel(character, message)) return true;
  const allowed = character.allowedChannelIds.length ? character.allowedChannelIds : config.allowed_channels;
  return allowed.length === 0 || scope.some((id) => allowed.includes(id));
}

/** Code blocks and inline code don't count when looking for a character's name. */
export function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
}

/** Title-like words that are too common to trigger on by themselves. */
const COMMON_NAME_WORDS = new Set([
  "the", "and", "captain", "mister", "miss", "missus", "lady", "lord", "sir", "dame", "doctor", "professor",
  "king", "queen", "prince", "princess", "uncle", "auntie", "grandma", "grandpa", "old", "little", "big",
  "great", "wise", "friendly", "happy", "robot", "bot", "chef", "detective", "agent", "master", "general",
]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Terms that count as saying a character's name: the full name, plus its distinctive words. */
export function nameTerms(name: string): string[] {
  const full = name.trim();
  const words = full.split(/\s+/).filter((w) => w.length >= 4 && !COMMON_NAME_WORDS.has(w.toLowerCase()));
  return [...new Set([full, ...words].filter(Boolean))];
}

/** Whole-word, case-insensitive: "barnacle" matches "Captain Barnacle", "barnacles" doesn't. */
export function mentionsName(content: string, name: string): boolean {
  const text = stripCode(content);
  return nameTerms(name).some((term) =>
    new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(term)}(?![\\p{L}\\p{N}_])`, "iu").test(text),
  );
}

/** Role ids mentioned in the message, in the order they appear. */
export function mentionedRoleIds(content: string): string[] {
  return [...new Set([...content.matchAll(/<@&(\d{15,25})>/g)].map((m) => m[1]!))];
}

/**
 * The characters a message talks to, at most two: role @mentions first (always on), then a reply
 * to a character's own message, the character's dedicated channel, and finally saying its name.
 */
export function resolveCharacterTargets<C extends TriggerCharacter>(
  message: TriggerMessage,
  characters: C[],
  config: TriggerConfig,
  isOwnWebhook: (webhookId: string) => boolean,
): TriggerMatch<C>[] {
  if (shouldIgnoreMessage(message)) return [];
  const usable = characters.filter((c) => c.enabled && c.reviewStatus === "approved" && channelAllowed(c, message, config));
  if (!usable.length) return [];

  const matches: TriggerMatch<C>[] = [];
  const add = (character: C | undefined, reason: TriggerReason) => {
    if (!character || matches.length >= MAX_CHARACTERS_PER_MESSAGE) return;
    if (matches.some((m) => m.character.id === character.id)) return;
    matches.push({ character, reason });
  };

  for (const roleId of mentionedRoleIds(message.content)) {
    add(usable.find((c) => c.roleId === roleId), "mention");
  }

  if (config.triggers.reply && message.reference?.webhookId && isOwnWebhook(message.reference.webhookId)) {
    const author = message.reference.authorName;
    add(usable.find((c) => c.name === author), "reply");
  }

  if (config.triggers.dedicated_channels) {
    add(usable.find((c) => isDedicatedChannel(c, message)), "dedicated");
  }

  if (config.triggers.name) {
    for (const character of usable) {
      if (mentionsName(message.content, character.name)) add(character, "name");
    }
  }
  return matches;
}
