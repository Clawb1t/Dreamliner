import { SUGGESTION_MODES } from "../../../config/schemas/suggestions.js";
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
  idOrEmpty,
  idRef,
  int,
  keepIds,
  nullable,
  obj,
  oneOf,
  progressInstruction,
  str,
  turnSchemaWithIds,
  validId,
  type AiWizardContext,
  type AiWizardDefinition,
  type IdKind,
} from "../wizardKit.js";

const MAX_QUESTIONS = 5;

const OPTIONAL_CHANNELS = ["review_channel_id", "denied_channel_id", "archive_channel_id", "log_channel_id"] as const;
const CHANNEL_LISTS = ["command_channels", "ignored_channels"] as const;
const ROLE_LISTS = ["allowed_suggest_roles", "blocked_suggest_roles", "allowed_vote_roles"] as const;
const OPTIONAL_ROLES = ["review_ping_role", "feed_ping_role", "approved_role", "implemented_role"] as const;
const DURATIONS = ["cooldown", "min_account_age", "min_member_age"] as const;
const LABELS = ["upvote_label", "midvote_label", "downvote_label"] as const;
const EMOJIS = ["upvote_emoji", "midvote_emoji", "downvote_emoji"] as const;
const TOGGLES = [
  "anonymous",
  "allow_attachments",
  "voting_enabled",
  "mid_vote_enabled",
  "allow_self_vote",
  "show_vote_count",
  "notify_author",
  "follow_on_upvote",
] as const;

export function suggestionsConfigSchema(): Record<string, unknown> {
  const props: Record<string, Record<string, unknown>> = {
    mode: nullable(oneOf(SUGGESTION_MODES)),
    suggestions_channel_id: nullable(idRef("text_channel")),
  };
  for (const key of OPTIONAL_CHANNELS) props[key] = nullable(idOrEmpty("text_channel"));
  for (const key of CHANNEL_LISTS) props[key] = nullable(idArray("text_channel"));
  for (const key of ROLE_LISTS) props[key] = nullable(idArray("role"));
  for (const key of OPTIONAL_ROLES) props[key] = nullable(idOrEmpty("role"));
  for (const key of DURATIONS) props[key] = nullable(str());
  props.max_open = nullable(int());
  props.min_messages = nullable(int());
  props.max_length = nullable(int());
  props.min_length = nullable(int());
  for (const key of LABELS) props[key] = nullable(str());
  for (const key of EMOJIS) props[key] = nullable(str());
  props.color_change_threshold = nullable(int());
  props.color_change_color = nullable(int());
  for (const key of TOGGLES) props[key] = nullable(bool());
  return obj(props);
}

/** Same shape the bot's parseDuration accepts: one number and unit, e.g. "30m", "1h", "7d", "2w". */
const DURATION_RE = /^\d+[smhdw]$/;

function checkIds(config: Record<string, unknown>, keys: readonly string[], ctx: AiWizardContext, kind: IdKind): void {
  for (const key of keys) if (!validId(config[key], ctx, kind)) config[key] = null;
}

export function validateSuggestionsConfig(config: Record<string, unknown>, ctx: AiWizardContext): string | null {
  const feed = config.suggestions_channel_id;
  if (feed !== null && feed !== undefined && (typeof feed !== "string" || !ctx.textChannels.some((c) => c.id === feed))) {
    return "Autopilot didn't pick a real suggestions channel. Please try again.";
  }
  const review = config.review_channel_id;
  if (review !== null && review !== undefined && !validId(review, ctx, "text_channel")) {
    return "Autopilot picked a review channel that doesn't exist. Please try again.";
  }
  if (config.mode === "review" && review === "") {
    return "Autopilot set review mode but didn't pick a staff review channel. Please try again.";
  }
  checkIds(config, OPTIONAL_CHANNELS, ctx, "text_channel");
  checkIds(config, OPTIONAL_ROLES, ctx, "role");
  for (const key of CHANNEL_LISTS) config[key] = keepIds(config[key], ctx, "text_channel");
  for (const key of ROLE_LISTS) config[key] = keepIds(config[key], ctx, "role");

  for (const key of DURATIONS) {
    const value = config[key];
    if (typeof value !== "string") {
      config[key] = null;
      continue;
    }
    const trimmed = value.trim().toLowerCase().replace(/\s+/g, "");
    config[key] = trimmed === "" || DURATION_RE.test(trimmed) ? trimmed : null;
  }
  config.max_open = clampInt(config.max_open, 0, 1_000_000);
  config.min_messages = clampInt(config.min_messages, 0, 1_000_000);
  config.max_length = clampInt(config.max_length, 1, 2000);
  config.min_length = clampInt(config.min_length, 1, 2000);
  if (typeof config.max_length === "number" && typeof config.min_length === "number" && config.min_length > config.max_length) {
    config.min_length = config.max_length;
  }
  for (const key of LABELS) {
    const value = config[key];
    config[key] = typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : null;
  }
  for (const key of EMOJIS) {
    const value = config[key];
    config[key] = typeof value === "string" && value.trim() ? resolveEmojiByName(value, ctx.emojis) : null;
  }
  config.color_change_threshold = clampInt(config.color_change_threshold, 0, 1_000_000);
  config.color_change_color = clampInt(config.color_change_color, 0, 0xffffff);
  for (const key of TOGGLES) if (typeof config[key] !== "boolean") config[key] = null;
  return null;
}

export const suggestionsWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 2500,
  requiresEntity: {
    kind: "textChannels",
    message: "This server has no text channels yet. Create one first, then try Autopilot setup again.",
  },
  buildResultSchema: (ctx) => turnSchemaWithIds(suggestionsConfigSchema(), ctx),
  validateConfig: validateSuggestionsConfig,
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up Dreamliner's Suggestions feature: members submit " +
    "ideas with /suggest, which either go straight to a public feed or through a staff review queue " +
    `first, and members vote on them with buttons. You are setting this up for the server "${ctx.guildName}". ` +
    "Ask ONE short, plain-language question at a time. Never mention field names, JSON, or config, " +
    "ask like a helpful person would. If they are setting it up for the first time, find out whether " +
    "staff should review suggestions before they go public (mode \"review\") or they post straight to " +
    "the feed (mode \"autoapprove\"), which channel the public feed is in, and in review mode which " +
    "channel staff review in. Then only ask about what they care about. " +
    NULL_MEANS_UNCHANGED_RULE +
    " " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nEverything Suggestions can do (null = leave as is):\n" +
    "- Channels: suggestions_channel_id (public feed), review_channel_id (staff queue, required in " +
    "review mode), denied_channel_id (where denied suggestions are moved), archive_channel_id " +
    "(where implemented ones are moved), log_channel_id (action log). Use \"\" to clear an optional one.\n" +
    "- Where /suggest works: command_channels (only these channels, empty list = anywhere), " +
    "ignored_channels (never in these).\n" +
    "- Roles: allowed_suggest_roles (only these can suggest, empty = everyone), blocked_suggest_roles " +
    "(can't suggest), allowed_vote_roles (only these can vote, empty = everyone), review_ping_role " +
    "(pinged when a suggestion enters review), feed_ping_role (pinged when one is posted to the " +
    "feed), approved_role (given to the author when approved), implemented_role (given when marked " +
    "implemented). Use \"\" to clear one of the single roles.\n" +
    "- Limits: cooldown (between suggestions per member), min_account_age (Discord account age), " +
    "min_member_age (time in this server), each a duration like \"30m\", \"1h\", \"7d\", \"2w\" (one " +
    "number and one unit) or \"\" to turn that limit off; min_messages (messages sent here first), " +
    "max_open (open approved suggestions per member, 0 = unlimited), min_length and max_length " +
    "(suggestion text length, 1 to 2000), anonymous (allow anonymous suggestions, staff still see " +
    "the author), allow_attachments (image attachments).\n" +
    "- Voting: voting_enabled, mid_vote_enabled (a neutral middle button), allow_self_vote, " +
    "show_vote_count (live totals on the buttons), button labels (upvote_label, midvote_label, " +
    "downvote_label, max 80 characters) and emojis (upvote_emoji, midvote_emoji, downvote_emoji: a " +
    "unicode emoji or a server emoji name from the list below), color_change_threshold (net upvotes " +
    "that recolor the embed, 0 = off) and color_change_color.\n" +
    "- Notifications: notify_author (DM the author when their suggestion is approved, denied or " +
    "marked), follow_on_upvote (upvoting a suggestion follows it for updates).\n" +
    COLOR_RULE +
    "\n\nExisting text channels:\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    "Existing roles (never pick a role that sounds like a bot/managed role, or @everyone):\n" +
    `${entityList(ctx.roles)}\n\n` +
    "Server emojis (use the name):\n" +
    `${emojiList(ctx.emojis)}\n\n` +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action " +
    "\"ready\" with the config and a short, friendly plain-language summary of the choices you " +
    "made (leave question null). Never invent ids; review_channel_id must be a real channel whenever " +
    "mode is review and no review channel is set up yet.",
};
