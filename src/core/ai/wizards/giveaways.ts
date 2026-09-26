/**
 * Giveaways Autopilot wizard: sets the guild-wide defaults a new giveaway is pre-filled with
 * (zGiveawaysConfig), including the default embed. Every field is nullable so the log channel,
 * ping role and anything else nobody mentioned stay as they are.
 */
import { TICKET_BUTTON_STYLES } from "../../../config/schemas/tickets.js";
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
  idOrEmpty,
  int,
  nullable,
  num,
  obj,
  oneOf,
  persistEmbedSchema,
  progressInstruction,
  str,
  turnSchemaWithIds,
  validId,
  type AiWizardDefinition,
} from "../wizardKit.js";
import { boolOrNull, sanitizePersistEmbed } from "./autoRuleKit.js";

const MAX_QUESTIONS = 6;

export function giveawaysConfigSchema(): Record<string, unknown> {
  return obj({
    log_channel_id: nullable(idOrEmpty("text_channel")),
    ping_role_id: nullable(idOrEmpty("role")),
    default_entry_method: nullable(oneOf(["button", "reaction"])),
    default_reaction_emoji: nullable(str()),
    default_button_label: nullable(str()),
    default_button_emoji: nullable(str()),
    default_button_style: nullable(oneOf(TICKET_BUTTON_STYLES)),
    default_winner_count: nullable(int()),
    default_embed: nullable(persistEmbedSchema()),
    default_dm_winner: nullable(bool()),
    default_dm_non_winners: nullable(bool()),
    default_claim_window_minutes: nullable(int()),
    default_require_role_mode: nullable(oneOf(["any", "all"])),
    default_booster_bonus_weight: nullable(num()),
    default_entry_cost: nullable(num()),
    default_win_bonus: nullable(num()),
  });
}

function nonNegative(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : null;
}

export const validateGiveawaysConfig: NonNullable<AiWizardDefinition["validateConfig"]> = (config, ctx) => {
  if (config.log_channel_id !== null && !validId(config.log_channel_id, ctx, "text_channel")) {
    return "Autopilot picked a log channel that doesn't exist. Please try again.";
  }
  if (config.ping_role_id !== null && !validId(config.ping_role_id, ctx, "role")) {
    return "Autopilot picked a ping role that doesn't exist. Please try again.";
  }
  if (typeof config.log_channel_id !== "string") config.log_channel_id = null;
  if (typeof config.ping_role_id !== "string") config.ping_role_id = null;

  config.default_entry_method =
    config.default_entry_method === "button" || config.default_entry_method === "reaction"
      ? config.default_entry_method
      : null;
  // A reaction giveaway always needs an emoji: blank means "keep the current one".
  const reaction =
    typeof config.default_reaction_emoji === "string"
      ? resolveEmojiByName(config.default_reaction_emoji, ctx.emojis).slice(0, 128)
      : "";
  config.default_reaction_emoji = reaction || null;
  // The button emoji is optional decoration: "" means no emoji.
  config.default_button_emoji =
    typeof config.default_button_emoji === "string"
      ? resolveEmojiByName(config.default_button_emoji, ctx.emojis).slice(0, 128)
      : null;
  const label = typeof config.default_button_label === "string" ? config.default_button_label.trim().slice(0, 80) : "";
  config.default_button_label = label || null;
  config.default_button_style =
    typeof config.default_button_style === "string" &&
    (TICKET_BUTTON_STYLES as readonly string[]).includes(config.default_button_style)
      ? config.default_button_style
      : null;
  config.default_winner_count = clampInt(config.default_winner_count, 1, 100);
  config.default_embed = sanitizePersistEmbed(config.default_embed);
  config.default_dm_winner = boolOrNull(config.default_dm_winner);
  config.default_dm_non_winners = boolOrNull(config.default_dm_non_winners);
  config.default_claim_window_minutes = clampInt(config.default_claim_window_minutes, 0, 10_080);
  config.default_require_role_mode =
    config.default_require_role_mode === "any" || config.default_require_role_mode === "all"
      ? config.default_require_role_mode
      : null;
  config.default_booster_bonus_weight = nonNegative(config.default_booster_bonus_weight, 1000);
  config.default_entry_cost = nonNegative(config.default_entry_cost, 1_000_000_000);
  config.default_win_bonus = nonNegative(config.default_win_bonus, 1_000_000_000);
  return null;
};

export const giveawaysWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 2500,
  buildResultSchema: (ctx) => turnSchemaWithIds(giveawaysConfigSchema(), ctx),
  validateConfig: validateGiveawaysConfig,
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up Dreamliner's Giveaways defaults: the settings a " +
    "new giveaway is pre-filled with when staff create one from the dashboard (giveaways themselves " +
    "are created and run from the dashboard, you are only choosing the starting defaults). You are " +
    `setting this up for the server "${ctx.guildName}". Ask ONE short, plain-language question at a ` +
    "time. Never mention field names, JSON, or config, ask like a helpful person would.\n\n" +
    "What can be set: log_channel_id (a channel logging giveaway start, end, and reroll events, \"\" " +
    "for none), ping_role_id (a role pinged when a giveaway starts, \"\" for none), " +
    "default_entry_method (members click a button or react with an emoji), default_reaction_emoji " +
    "(the reaction for reaction giveaways), default_button_label (max 80 characters), " +
    "default_button_emoji (\"\" for no emoji) and default_button_style (primary blurple, secondary " +
    "gray, success green, danger red), default_winner_count (1 to 100), default_embed (the giveaway " +
    "post's embed: title, description, color, author, thumbnail, image, footer, timestamp, up to 25 " +
    "fields; icon and thumbnail sources are none, guild, bot, or url; the title falls back to the " +
    "prize, and the prize, end time, entry count, and requirements are added below the description " +
    "automatically, so never write those yourself; {guild} works as a placeholder), " +
    "default_dm_winner and default_dm_non_winners (DM winners and non-winners when it ends), " +
    "default_claim_window_minutes (minutes a winner has to claim before an automatic reroll, up to " +
    "10080, 0 turns it off), default_require_role_mode (a required-role list matches \"any\" or " +
    "\"all\" of its roles), default_booster_bonus_weight (extra entry weight for server boosters, 0 " +
    "off), default_entry_cost (server currency it costs to enter, 0 free), default_win_bonus (server " +
    "currency a winner gets when they claim, 0 none). " +
    COLOR_RULE +
    "\n\nCover the basics in a few questions: how members enter, how many winners, and whether " +
    "winners get a DM. Only bring up the rest if the user seems interested. If the user has no " +
    "preference for an emoji, leave it null so Dreamliner keeps its own gift emoji. Use null for " +
    "log_channel_id and ping_role_id unless the user names one; \"\" removes the current one, so " +
    "only use it when they ask for no log or no ping. " +
    NULL_MEANS_UNCHANGED_RULE +
    " " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nExisting text channels (pick log_channel_id from these ids only):\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    "Existing roles (pick ping_role_id from these ids only):\n" +
    `${entityList(ctx.roles)}\n\n` +
    `This server's custom emoji: ${emojiList(ctx.emojis)}. If the user means one of these (even just ` +
    "by name), put its exact name with no colons in default_reaction_emoji or default_button_emoji " +
    "and Dreamliner will use the real custom emoji. Otherwise use a literal Unicode emoji.\n\n" +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action \"ready\" " +
    "with the config and a short, friendly plain-language summary of the choices you made (leave " +
    "question null).",
};
