/**
 * Categories every log card's title emoji is chosen from. Guilds can override each category's
 * glyph in `logging.emojis` (dashboard: Server → Logging Emojis); these are the fallback values
 * (Dreamliner's own "dl_*" application emojis) used when a guild hasn't set an override — and the
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
  action: "<:dl_action:1540811113711665203>",
  create: "<:dl_create:1540811386790346793>",
  delete: "<:dl_delete:1540811399993757816>",
  edit: "<:dl_edit:1540811455249645668>",
  emojiSticker: "<:dl_emoji:1540811163284144169>",
  join: "<:dl_join:1540811526447824976>",
  leave: "<:dl_leave:1540811513802133554>",
  voice: "<:dl_voice:1540811146380972144>",
  unban: "<:dl_unban:1540811470391214111>",
  serverUpdate: "<:dl_serverupdate:1540811181290160328>",
  modDefault: "<:dl_moderation_default:1540811132242239651>",
  modModerate: "<:dl_moderation_moderate:1540811497184297040>",
  modSevere: "<:dl_moderation_severe:1540811485079671046>",
};

/** Resolves a category to the guild's configured override, falling back to the Dreamliner default. */
export function resolveLogEmoji(
  category: LogEmojiCategory,
  overrides?: Partial<Record<LogEmojiCategory, string | null | undefined>> | null,
): string {
  const override = overrides?.[category];
  return override && override.trim() ? override.trim() : LOG_EMOJI[category];
}
