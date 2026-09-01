/**
 * Categories every log card's title emoji is chosen from. Guilds can override each category's
 * glyph in `logging.emojis` (dashboard: Server → Logging Emojis); these are the fallback values
 * (Dreamliner's own application emojis) used when a guild hasn't set an override — and the
 * pool a builder picks from via `LogCard.emojiCategory`. No plain unicode emoji is ever used.
 */
export type LogEmojiCategory =
  | "action"
  | "create"
  | "delete"
  | "edit"
  | "emojiSticker"
  | "join"
  | "leave"
  | "voice"
  | "unban"
  | "serverUpdate"
  | "modDefault"
  | "modModerate"
  | "modSevere";

export const LOG_EMOJI_CATEGORIES: LogEmojiCategory[] = [
  "action",
  "create",
  "delete",
  "edit",
  "emojiSticker",
  "join",
  "leave",
  "voice",
  "unban",
  "serverUpdate",
  "modDefault",
  "modModerate",
  "modSevere",
];

export const LOG_EMOJI_CATEGORY_LABELS: Record<LogEmojiCategory, string> = {
  action: "Generic action",
  create: "Create",
  delete: "Delete",
  edit: "Edit / update",
  emojiSticker: "Emoji & sticker",
  join: "Join",
  leave: "Leave",
  voice: "Voice",
  unban: "Unban",
  serverUpdate: "Server update",
  modDefault: "Moderation (routine)",
  modModerate: "Moderation (moderate)",
  modSevere: "Moderation (severe)",
};

/** Default glyph per category — Dreamliner's own application emojis. */
export const LOG_EMOJI: Record<LogEmojiCategory, string> = {
  action: "<:icons_slashcmd:1544417581765501059>",
  create: "<:icons_plus:1544417389872156732>",
  delete: "<:icons_trash:1544418246705418332>",
  edit: "<:icons_edit:1544417261115281441>",
  emojiSticker: "<:icons_createemoji:1544417838511423538>",
  join: "<:icons_djoin:1544417221902864524>",
  leave: "<:icons_dleave:1544417225430274058>",
  voice: "<:icons_voice:1544418279760601158>",
  unban: "<:icons_unbanmember:1544417814549495899>",
  serverUpdate: "<:icons_updateserver:1544417824074768584>",
  modDefault: "<:icons_moderationlow:1544418102001799328>",
  modModerate: "<:icons_moderationmedium:1544418103494971402>",
  modSevere: "<:icons_moderationhighest:1544418100663812167>",
};

/** Resolves a category to the guild's configured override, falling back to the Dreamliner default. */
export function resolveLogEmoji(
  category: LogEmojiCategory,
  overrides?: Partial<Record<LogEmojiCategory, string | null | undefined>> | null,
): string {
  const override = overrides?.[category];
  return override && override.trim() ? override.trim() : LOG_EMOJI[category];
}
