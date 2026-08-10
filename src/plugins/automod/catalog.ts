import {
  AUTOMOD_ACTION_TYPES,
  AUTOMOD_PRESETS,
  AUTOMOD_RULE_IDS,
  AUTOMOD_SENSITIVITIES,
  type AutomodRuleId,
} from "../../config/schemas/automod.js";
import { PROFANITY_WORDS } from "./functions/packs/profanity.js";
import { SLUR_WORDS } from "./functions/packs/slurs.js";

export type AutomodRuleGroup = "content" | "spam" | "mentions_links" | "presentation" | "raid";

export type AutomodRuleMeta = {
  id: AutomodRuleId;
  name: string;
  description: string;
  group: AutomodRuleGroup;
  event: "message" | "member_join";
};

export const AUTOMOD_RULE_META: AutomodRuleMeta[] = [
  {
    id: "profanity",
    name: "Profanity",
    description: "Blocks common swear words from Dreamliner’s built-in pack.",
    group: "content",
    event: "message",
  },
  {
    id: "slurs",
    name: "Slur detection",
    description: "Blocks hate-speech / slur terms (separate from casual swearing).",
    group: "content",
    event: "message",
  },
  {
    id: "excessive_swearing",
    name: "Excessive swearing",
    description: "Flags messages that pack many swear words into one burst.",
    group: "content",
    event: "message",
  },
  {
    id: "custom_filter",
    name: "Custom filters",
    description: "Your own words, phrases, and regex patterns (replaces Censor).",
    group: "content",
    event: "message",
  },
  {
    id: "spam",
    name: "Spam",
    description: "Too many messages from one user in a short window.",
    group: "spam",
    event: "message",
  },
  {
    id: "emoji_spam",
    name: "Emoji spam",
    description: "Messages overloaded with emoji or custom emotes.",
    group: "spam",
    event: "message",
  },
  {
    id: "duplicate",
    name: "Duplicate messages",
    description: "Same user repeating the same message.",
    group: "spam",
    event: "message",
  },
  {
    id: "copypasta",
    name: "Copypasta",
    description: "Identical or near-identical text pasted across the server.",
    group: "spam",
    event: "message",
  },
  {
    id: "sticker_gif_spam",
    name: "Sticker & GIF spam",
    description: "Rapid stickers, GIFs, or Tenor/Giphy embeds.",
    group: "spam",
    event: "message",
  },
  {
    id: "attachment_spam",
    name: "Attachment spam",
    description: "Rapid file uploads from one user.",
    group: "spam",
    event: "message",
  },
  {
    id: "newline_spam",
    name: "Newline spam",
    description: "Messages with excessive line breaks.",
    group: "spam",
    event: "message",
  },
  {
    id: "wall_of_text",
    name: "Wall of text",
    description: "Extremely long messages that flood the channel.",
    group: "spam",
    event: "message",
  },
  {
    id: "repeated_chars",
    name: "Repeated characters",
    description: "Character floods like aaaaaaa or !!!!!!!.",
    group: "spam",
    event: "message",
  },
  {
    id: "mass_mentions",
    name: "Mass mentions",
    description: "Too many unique user mentions in one message.",
    group: "mentions_links",
    event: "message",
  },
  {
    id: "everyone_here",
    name: "@everyone / @here",
    description: "Unauthorized everyone or here pings.",
    group: "mentions_links",
    event: "message",
  },
  {
    id: "invites",
    name: "Invite links",
    description: "Discord invite links in messages.",
    group: "mentions_links",
    event: "message",
  },
  {
    id: "links",
    name: "Link spam",
    description: "Too many links, or links on a blocked domain list.",
    group: "mentions_links",
    event: "message",
  },
  {
    id: "excessive_caps",
    name: "Excessive caps",
    description: "Shouting with too high a percentage of capital letters.",
    group: "presentation",
    event: "message",
  },
  {
    id: "zalgo",
    name: "Zalgo / obfuscation",
    description: "Abuse of combining marks that make text unreadable.",
    group: "presentation",
    event: "message",
  },
  {
    id: "raid",
    name: "Raid detection",
    description: "Burst of member joins that looks like a raid.",
    group: "raid",
    event: "member_join",
  },
];

export const AUTOMOD_GROUP_LABELS: Record<AutomodRuleGroup, string> = {
  content: "Content filters",
  spam: "Spam & noise",
  mentions_links: "Mentions & links",
  presentation: "Presentation",
  raid: "Join protection",
};

/** Built-in word packs keyed by rule id (for dashboard preview). */
export const AUTOMOD_WORD_PACKS: Partial<Record<AutomodRuleId, readonly string[]>> = {
  profanity: PROFANITY_WORDS,
  excessive_swearing: PROFANITY_WORDS,
  slurs: SLUR_WORDS,
};

export function getAutomodCatalog() {
  return {
    ruleIds: [...AUTOMOD_RULE_IDS],
    rules: AUTOMOD_RULE_META,
    groups: AUTOMOD_GROUP_LABELS,
    sensitivities: [...AUTOMOD_SENSITIVITIES],
    actionTypes: [...AUTOMOD_ACTION_TYPES],
    presets: [...AUTOMOD_PRESETS],
    wordPacks: {
      profanity: [...PROFANITY_WORDS],
      excessive_swearing: [...PROFANITY_WORDS],
      slurs: [...SLUR_WORDS],
    } satisfies Partial<Record<AutomodRuleId, string[]>>,
  };
}
