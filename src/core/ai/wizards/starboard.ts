/**
 * Starboard Autopilot wizard: adds one board per run with every per-board setting zStarboardBoard
 * supports, plus the plugin-wide defaults (zStarboardSharedOptions) as an optional `global` block
 * that is only applied when the user asked for it.
 */
import { resolveEmojiByName } from "../../emoji.js";
import {
  ANSWER_KIND_RULE,
  COLOR_RULE,
  NEVER_EM_DASH_RULE,
  NULL_MEANS_UNCHANGED_RULE,
  bool,
  clampInt,
  emojiList,
  entityList,
  idArray,
  idRef,
  int,
  keepIds,
  nullable,
  num,
  obj,
  progressInstruction,
  str,
  turnSchemaWithIds,
  validId,
  type AiWizardContext,
  type AiWizardDefinition,
} from "../wizardKit.js";
import { boolOrNull, isRow } from "./autoRuleKit.js";

const MAX_QUESTIONS = 5;
const MAX_STAR_EMOJIS = 20;
export const DEFAULT_STAR_EMOJI = "⭐";

function sharedOptionFields(): Record<string, Record<string, unknown>> {
  return {
    ignored_channels: nullable(idArray("text_channel")),
    ignored_roles: nullable(idArray("role")),
    allow_bot_messages: nullable(bool()),
    allow_nsfw: nullable(bool()),
    color: nullable(int()),
  };
}

export function starboardConfigSchema(): Record<string, unknown> {
  return obj({
    name: nullable(str()),
    channel_id: idRef("text_channel"),
    enabled: nullable(bool()),
    stars_required: nullable(int()),
    star_emoji: nullable({ type: "array", items: str() }),
    show_star_count: nullable(bool()),
    copy_full_embed: nullable(bool()),
    count_self_stars: nullable(bool()),
    ...sharedOptionFields(),
    economy_bonus: nullable(num()),
    global: nullable(obj(sharedOptionFields())),
  });
}

/** Board key rules, same as the dashboard's normalizeBoardName. */
export function normalizeBoardName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 32);
}

/** Resolves server emoji names, drops blanks and duplicates. An emptied list falls back to a star. */
export function sanitizeStarEmojis(value: unknown, ctx: AiWizardContext): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = [
    ...new Set(
      value
        .filter((e): e is string => typeof e === "string")
        .map((e) => resolveEmojiByName(e, ctx.emojis).slice(0, 128))
        .filter(Boolean),
    ),
  ].slice(0, MAX_STAR_EMOJIS);
  return out.length ? out : [DEFAULT_STAR_EMOJI];
}

function sanitizeSharedOptions(row: Record<string, unknown>, ctx: AiWizardContext): void {
  row.ignored_channels = keepIds(row.ignored_channels, ctx, "text_channel");
  row.ignored_roles = keepIds(row.ignored_roles, ctx, "role");
  row.allow_bot_messages = boolOrNull(row.allow_bot_messages);
  row.allow_nsfw = boolOrNull(row.allow_nsfw);
  row.color = clampInt(row.color, 0, 0xffffff);
}

export const validateStarboardConfig: NonNullable<AiWizardDefinition["validateConfig"]> = (config, ctx) => {
  const channelId = config.channel_id;
  if (typeof channelId !== "string" || !channelId || !validId(channelId, ctx, "text_channel")) {
    return "Autopilot didn't pick a real channel for the board. Please try again.";
  }
  const name = typeof config.name === "string" ? normalizeBoardName(config.name) : "";
  config.name = name || null;
  config.enabled = boolOrNull(config.enabled);
  config.stars_required = clampInt(config.stars_required, 1, 1000);
  config.star_emoji = sanitizeStarEmojis(config.star_emoji, ctx);
  config.show_star_count = boolOrNull(config.show_star_count);
  config.copy_full_embed = boolOrNull(config.copy_full_embed);
  config.count_self_stars = boolOrNull(config.count_self_stars);
  sanitizeSharedOptions(config, ctx);
  config.economy_bonus =
    typeof config.economy_bonus === "number" && Number.isFinite(config.economy_bonus)
      ? Math.min(1_000_000, Math.max(0, config.economy_bonus))
      : null;
  if (isRow(config.global)) {
    sanitizeSharedOptions(config.global, ctx);
  } else {
    config.global = null;
  }
  return null;
};

export const starboardWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 2000,
  requiresEntity: {
    kind: "textChannels",
    message: "This server has no text channels yet. Create one first, then try Autopilot setup again.",
  },
  buildResultSchema: (ctx) => turnSchemaWithIds(starboardConfigSchema(), ctx),
  validateConfig: validateStarboardConfig,
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up a Starboard board: when a message gets enough " +
    "star reactions, Dreamliner reposts it to a chosen channel so the best messages get highlighted. " +
    `You are setting this up for the server "${ctx.guildName}". Ask ONE short, plain-language ` +
    "question at a time. Never mention field names, JSON, or config, ask like a helpful person " +
    "would.\n\n" +
    "What a board can do: channel_id is where starred messages are posted (required). name is a " +
    "short board name (lowercase letters, numbers, _ or -, e.g. \"main\" or \"memes\"), null to pick " +
    "one automatically. stars_required is how many stars a message needs (default 3). star_emoji is " +
    "the list of emoji that count as a star (default a star); a board can accept several. " +
    "show_star_count shows the count on the post, copy_full_embed copies embeds from the original " +
    "message, count_self_stars counts a member starring their own message (default off). " +
    "ignored_channels are channels whose messages this board never posts, ignored_roles are roles " +
    "whose members' messages are never posted. allow_bot_messages lets bot messages be starred, " +
    "allow_nsfw allows messages from NSFW channels, and color is the board's embed color; these " +
    "three override the server-wide default for this board only. economy_bonus is server currency " +
    "awarded to the author when their message first reaches the threshold (0 for none). enabled " +
    "turns the board on or off.\n" +
    "Server-wide defaults that apply to every board go in global: ignored_channels and ignored_roles " +
    "(merged with each board's own lists), allow_bot_messages (default off), allow_nsfw (default " +
    "on), and color. Only fill global when the user says a rule should apply to all boards or the " +
    "whole starboard; otherwise set global to null. " +
    COLOR_RULE +
    "\n\nFocus on the channel, how many stars, and whether they want a different star emoji. " +
    NULL_MEANS_UNCHANGED_RULE +
    " " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nExisting text channels (pick channel_id and ignored_channels from these ids only):\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    "Existing roles (pick ignored_roles from these ids only):\n" +
    `${entityList(ctx.roles)}\n\n` +
    `This server's custom emoji: ${emojiList(ctx.emojis)}. If the user means one of these (even just ` +
    "by name), put its exact name with no colons in star_emoji and Dreamliner will use the real " +
    "custom emoji. Otherwise use a literal Unicode emoji. Never leave star_emoji as an empty list; " +
    "use null to keep the default star.\n\n" +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action \"ready\" " +
    "with the config and a short, friendly plain-language summary of the choices you made (leave " +
    "question null). A board always needs a real channel_id from the list above, never invent one.",
};
