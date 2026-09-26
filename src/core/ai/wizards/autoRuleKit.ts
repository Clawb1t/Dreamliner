/**
 * Pieces shared by the rule-list wizards (Autoreplies, Autoreactions, Autothreads) and the rich
 * message wizards (Persist): the trigger/match fields every "watch messages" rule has, the
 * rich-message payload (embed, link buttons, webhook identity, delivery flags), and the
 * validateConfig sanitizers that mirror the plugin zod bounds.
 */
import { MAX_USER_PATTERN_LENGTH, validateRegexPatternSync } from "../../regexSafety.js";
import { resolveEmojiByName } from "../../emoji.js";
import {
  AUTO_TRIGGERS,
  bool,
  clampInt,
  idOrEmpty,
  int,
  linkButtonsSchema,
  nullable,
  oneOf,
  persistEmbedSchema,
  str,
  validId,
  type AiWizardContext,
} from "../wizardKit.js";

/** Most rules one wizard run may add (a MEE6/Dyno import can carry many). */
export const MAX_RULES_PER_RUN = 25;

type Row = Record<string, unknown>;

export function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Fields every message-watching rule has (zAutoreactionsConfig / zAutorepliesConfig / zAutothreadsConfig). */
export function autoRuleMatchFields(): Record<string, Record<string, unknown>> {
  return {
    channel_id: idOrEmpty("text_channel"),
    trigger: oneOf(AUTO_TRIGGERS),
    match: str(),
    every_n: nullable(int()),
    cooldown_seconds: nullable(int()),
    attachments_only: nullable(bool()),
    links_only: nullable(bool()),
  };
}

/** The rich message payload shared by autoreplies, autothreads and persist. */
export function richMessageFields(): Record<string, Record<string, unknown>> {
  return {
    embed: nullable(persistEmbedSchema()),
    buttons: linkButtonsSchema(),
    webhook: nullable(bool()),
    webhook_name: nullable(str()),
    webhook_avatar_url: nullable(str()),
    silent: nullable(bool()),
    suppress_embeds: nullable(bool()),
    mention_users: nullable(bool()),
    mention_roles: nullable(bool()),
    mention_everyone: nullable(bool()),
  };
}

export const AUTO_RULE_PROMPT_NOTES =
  "Rule matching: channel_id is one channel id from the list, or \"\" for all channels. trigger is " +
  "every_message, contains, starts_with, exact, or regex (all case-insensitive). match is the word, " +
  "phrase, or pattern (max 200 characters) and must be \"\" for every_message. Regex runs on a safe " +
  "engine without backreferences or lookbehind, so keep patterns simple (whole word: \\bword\\b). " +
  "Optional per-rule filters: every_n (only act on every Nth matching message, 2 to 1000, or 0 for " +
  "every match), cooldown_seconds (0 to 86400 between triggers of this rule), attachments_only " +
  "(only messages with attachments), links_only (only messages with links).";

export const RICH_MESSAGE_PROMPT_NOTES =
  "Message options: the text (max 2000 characters) can be combined with an embed (set embed.enabled " +
  "true plus title, description, color, author, thumbnail, image, footer, timestamp, and up to 25 " +
  "fields; thumbnail and icon sources are none, guild, bot, or url) and up to 5 link buttons " +
  "(label, https url, optional emoji). It can be sent as a webhook with a custom name and avatar " +
  "URL (webhook, webhook_name, webhook_avatar_url), silently without notifications (silent), with " +
  "link previews off (suppress_embeds), and with control over which pings actually notify " +
  "(mention_users and mention_roles default on, mention_everyone defaults off).";

/** Result of sanitizing one rule's trigger fields: an error string means the rule is unusable. */
export function sanitizeAutoRuleMatch(rule: Row, ctx: AiWizardContext): string | null {
  if (!validId(rule.channel_id, ctx, "text_channel")) return "a channel that doesn't exist";
  if (typeof rule.channel_id !== "string") rule.channel_id = "";
  if (typeof rule.trigger !== "string" || !(AUTO_TRIGGERS as readonly string[]).includes(rule.trigger)) {
    return "an unknown trigger";
  }
  if (rule.trigger === "every_message") {
    rule.match = "";
  } else {
    const match = typeof rule.match === "string" ? rule.match.trim().slice(0, MAX_USER_PATTERN_LENGTH) : "";
    if (!match) return "no word or phrase to match";
    if (rule.trigger === "regex" && !validateRegexPatternSync(match, "i").ok) return "a regex that doesn't compile";
    rule.match = match;
  }
  rule.every_n = sanitizeEveryN(rule.every_n);
  rule.cooldown_seconds = clampInt(rule.cooldown_seconds, 0, 86_400);
  rule.attachments_only = boolOrNull(rule.attachments_only);
  rule.links_only = boolOrNull(rule.links_only);
  return null;
}

/** 0 (or 1) means "every match", 2..1000 means every Nth; null stays null. */
export function sanitizeEveryN(value: unknown): number | null {
  const n = clampInt(value, 0, 1000);
  if (n === null) return null;
  return n < 2 ? 0 : n;
}

export function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function strOrNull(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.trim().slice(0, max) : null;
}

const EMBED_STRING_LIMITS: Record<string, number> = {
  title: 256,
  title_url: 512,
  description: 4096,
  author_name: 256,
  author_url: 512,
  author_icon_url: 512,
  thumbnail_url: 512,
  image_url: 512,
  footer_text: 2048,
  footer_icon_url: 512,
};
const PERSIST_ICONS = ["none", "guild", "bot", "url"];

/** Clamps a persistEmbedSchema() value to zPersistEmbedConfig bounds; null stays null. */
export function sanitizePersistEmbed(value: unknown): Row | null {
  if (!isRow(value)) return null;
  const embed: Row = { ...value };
  for (const [key, max] of Object.entries(EMBED_STRING_LIMITS)) {
    embed[key] = typeof embed[key] === "string" ? (embed[key] as string).slice(0, max) : null;
  }
  for (const key of ["author_icon", "thumbnail", "footer_icon"]) {
    if (typeof embed[key] !== "string" || !PERSIST_ICONS.includes(embed[key] as string)) embed[key] = null;
  }
  embed.enabled = boolOrNull(embed.enabled);
  embed.timestamp = boolOrNull(embed.timestamp);
  embed.color = clampInt(embed.color, 0, 0xffffff);
  if (Array.isArray(embed.fields)) {
    embed.fields = embed.fields
      .filter(isRow)
      .map((f) => ({
        name: typeof f.name === "string" ? f.name.slice(0, 256) : "",
        value: typeof f.value === "string" ? f.value.slice(0, 1024) : "",
        inline: f.inline === true,
      }))
      .filter((f) => f.name.trim() || f.value.trim())
      .slice(0, 25);
  } else {
    embed.fields = null;
  }
  return embed;
}

/** Filters a linkButtonsSchema() value to valid zPersistButton entries; null stays null. */
export function sanitizeLinkButtons(value: unknown, ctx: AiWizardContext): Row[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter(isRow)
    .map((b) => ({
      label: typeof b.label === "string" ? b.label.trim().slice(0, 80) : "",
      url: typeof b.url === "string" ? b.url.trim().slice(0, 512) : "",
      emoji: typeof b.emoji === "string" ? resolveEmojiByName(b.emoji, ctx.emojis).slice(0, 128) : "",
    }))
    .filter((b) => b.label && /^https?:\/\/\S+$/i.test(b.url))
    .slice(0, 5);
}

/** Sanitizes every richMessageFields() key on `row` in place. */
export function sanitizeRichMessage(row: Row, ctx: AiWizardContext): void {
  row.embed = sanitizePersistEmbed(row.embed);
  row.buttons = sanitizeLinkButtons(row.buttons, ctx);
  row.webhook = boolOrNull(row.webhook);
  row.webhook_name = strOrNull(row.webhook_name, 80);
  row.webhook_avatar_url = strOrNull(row.webhook_avatar_url, 512);
  for (const key of ["silent", "suppress_embeds", "mention_users", "mention_roles", "mention_everyone"]) {
    row[key] = boolOrNull(row[key]);
  }
}

/** True when the message has something to show besides its text (mirrors stickyHasContent in persist/functions/messageBuilder.ts). */
export function hasEmbedOrButtons(row: Row): boolean {
  const embed = isRow(row.embed) ? row.embed : null;
  const embedOn =
    embed?.enabled === true &&
    (["title", "description", "author_name", "footer_text", "image_url"].some(
      (key) => typeof embed[key] === "string" && (embed[key] as string).trim(),
    ) ||
      (Array.isArray(embed.fields) &&
        embed.fields.some((f) => isRow(f) && String(f.name ?? "").trim() && String(f.value ?? "").trim())));
  return embedOn || (Array.isArray(row.buttons) && row.buttons.length > 0);
}

/**
 * Runs `sanitize` on each rule in config.rules, drops unusable ones, caps the list, and returns an
 * error only when nothing usable is left.
 */
export function sanitizeRuleList(
  config: Row,
  noun: string,
  sanitize: (rule: Row) => string | null,
): string | null {
  const raw = Array.isArray(config.rules) ? config.rules.filter(isRow) : [];
  const problems: string[] = [];
  const kept: Row[] = [];
  for (const rule of raw.slice(0, MAX_RULES_PER_RUN)) {
    const problem = sanitize(rule);
    if (problem) problems.push(problem);
    else kept.push(rule);
  }
  config.rules = kept;
  if (kept.length === 0) {
    const why = problems.length ? ` (${problems[0]})` : "";
    return `Autopilot didn't produce a usable ${noun}${why}. Please try again.`;
  }
  return null;
}
