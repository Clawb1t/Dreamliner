import type { LogEmojiCategory } from "./emojis.js";

export type { LogEmojiCategory } from "./emojis.js";

export type LogRef = {
  id: string;
  name?: string;
  avatarUrl?: string;
  /** Unix ms account/entity creation time, when known (adds an "Account created" line). */
  createdAt?: number | null;
  /** Unix ms guild join time, when known and relevant (adds a "Joined server" line). */
  joinedAt?: number | null;
  bot?: boolean;
};

export type LogButtonStyle = "primary" | "secondary" | "success" | "danger" | "link";

/**
 * A button attached to a log card. Only `style: "link"` (or omitted, which also renders as a
 * plain link) is currently wired up — it needs no interaction handling, matching the pattern
 * already used for support/dashboard links elsewhere in the bot (see core/docsUrl.ts).
 */
export type LogButton = {
  label: string;
  url: string;
  style?: LogButtonStyle;
  emoji?: string;
};

/** A file attached alongside a log card, e.g. full message content that didn't fit inline. */
export type LogFile = {
  /** File name including extension, e.g. "message-content.txt". */
  name: string;
  content: string;
};

export type LogCard = {
  title: string;
  avatarUrl?: string | null;
  information: string[];
  extra?: string;
  buttons?: LogButton[];
  files?: LogFile[];
  /**
   * Which custom emoji category prefixes this card's title. Resolved centrally in
   * core/logging/send.ts against the guild's `logging.emojis` overrides (falling back to the
   * Dreamliner defaults in core/logging/emojis.ts) — builders never embed a literal emoji glyph.
   * Defaults to "action" when omitted.
   */
  emojiCategory?: LogEmojiCategory;
};
