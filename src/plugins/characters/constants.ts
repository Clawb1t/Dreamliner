export const PLUGIN = "characters";

/** The bot's webhook in each channel characters talk in. Each message overrides name and avatar. */
export const CHARACTERS_WEBHOOK_NAME = "Dreamliner Characters";

export const CHARACTER_EMOJI = "<:icons_spark:1544417582986297466>";

export const REPLY_STYLES = ["short", "medium", "long"] as const;
export type ReplyStyle = (typeof REPLY_STYLES)[number];

/** Field limits for a character definition (the dashboard shows the same counters). */
export const CHARACTER_LIMITS = {
  name: 80,
  tagline: 120,
  personality: 3000,
  scenario: 1000,
  greeting: 1000,
  exampleDialogue: 2000,
  dedicatedChannels: 5,
  allowedChannels: 25,
  avatarUrl: 500,
} as const;

export const TEMPERATURE_MIN = 0.3;
export const TEMPERATURE_MAX = 1.2;
export const TEMPERATURE_DEFAULT = 0.9;

/** At most this many characters answer one message. */
export const MAX_CHARACTERS_PER_MESSAGE = 2;

/** Tone presets for "How it talks" ("" = no preset). The prompt has one instruction per tone. */
export const CHARACTER_TONES = [
  "warm",
  "cheerful",
  "playful",
  "calm",
  "wise",
  "shy",
  "mysterious",
  "dramatic",
  "sarcastic",
  "grumpy",
  "angry",
  "scary",
  "chaotic",
  "formal",
] as const;
export type CharacterTone = (typeof CHARACTER_TONES)[number] | "";

export const EMOJI_USES = ["none", "some", "lots"] as const;
export type EmojiUse = (typeof EMOJI_USES)[number];

export const FORMALITIES = ["casual", "balanced", "formal"] as const;
export type Formality = (typeof FORMALITIES)[number];

export const CATCHPHRASE_LIMITS = { count: 5, length: 60 } as const;

/** Autopilot "describe your character": the description's max length. */
export const DRAFT_DESCRIPTION_MAX = 500;
