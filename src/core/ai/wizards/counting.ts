import { COUNTING_RESET_TARGETS } from "../../../config/schemas/counting.js";
import { resolveEmojiByName } from "../../emoji.js";
import {
  ANSWER_KIND_RULE,
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
  oneOf,
  progressInstruction,
  str,
  turnSchemaWithIds,
  type AiWizardContext,
  type AiWizardDefinition,
} from "../wizardKit.js";

const MAX_QUESTIONS = 5;

export function countingConfigSchema(): Record<string, unknown> {
  return obj({
    channel_id: idRef("text_channel"),
    name: nullable(str()),
    enabled: nullable(bool()),
    start_at: nullable(int()),
    step: nullable(int()),
    allow_math: nullable(bool()),
    require_alternate_user: nullable(bool()),
    cooldown_seconds: nullable(int()),
    allow_bots: nullable(bool()),
    allow_non_number_messages: nullable(bool()),
    delete_wrong_messages: nullable(bool()),
    reset_on_mistake: nullable(bool()),
    reset_to: nullable(oneOf(COUNTING_RESET_TARGETS)),
    milestone_every: nullable(int()),
    economy_milestone_bonus: nullable(num()),
    announce_milestones: nullable(bool()),
    pin_milestones: nullable(bool()),
    announce_new_record: nullable(bool()),
    announce_failure: nullable(bool()),
    success_reaction: nullable(str()),
    failure_reaction: nullable(str()),
    milestone_reaction: nullable(str()),
    failure_message: nullable(str()),
    milestone_message: nullable(str()),
    record_message: nullable(str()),
    ignored_roles: nullable(idArray("role")),
    allowed_roles: nullable(idArray("role")),
    use_webhook: nullable(bool()),
    webhook_name: nullable(str()),
    webhook_avatar_url: nullable(str()),
  });
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

function reaction(value: unknown, ctx: AiWizardContext): string | null {
  if (typeof value !== "string") return null;
  return resolveEmojiByName(value, ctx.emojis).slice(0, 128);
}

export function validateCountingConfig(config: Record<string, unknown>, ctx: AiWizardContext): string | null {
  const channelId = config.channel_id;
  if (typeof channelId !== "string" || !ctx.textChannels.some((c) => c.id === channelId)) {
    return "Autopilot picked a channel that doesn't exist. Please try again.";
  }
  config.name = typeof config.name === "string" ? config.name.trim().slice(0, 80) : null;
  config.start_at = clampInt(config.start_at, 0, 2_147_483_647);
  config.step = clampInt(config.step, 1, 1000);
  config.cooldown_seconds = clampInt(config.cooldown_seconds, 0, 3600);
  config.milestone_every = clampInt(config.milestone_every, 0, 1_000_000);
  const bonus = config.economy_milestone_bonus;
  config.economy_milestone_bonus = typeof bonus === "number" && Number.isFinite(bonus) ? Math.max(0, bonus) : null;
  // "Back to the last milestone" needs milestones; with them explicitly off, reset to zero instead.
  if (config.reset_to === "last_milestone" && config.milestone_every === 0) config.reset_to = "zero";
  for (const key of ["success_reaction", "failure_reaction", "milestone_reaction"] as const) {
    config[key] = reaction(config[key], ctx);
  }
  config.failure_message = text(config.failure_message, 300);
  config.milestone_message = text(config.milestone_message, 300);
  config.record_message = text(config.record_message, 300);
  config.ignored_roles = keepIds(config.ignored_roles, ctx, "role");
  config.allowed_roles = keepIds(config.allowed_roles, ctx, "role");
  config.webhook_name = text(config.webhook_name, 80);
  const avatar = config.webhook_avatar_url;
  config.webhook_avatar_url =
    typeof avatar === "string" && (avatar === "" || /^https:\/\/\S+$/i.test(avatar)) ? avatar.slice(0, 512) : null;
  return null;
}

export const countingWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 2500,
  requiresEntity: {
    kind: "textChannels",
    message: "This server has no text channels yet. Create one first, then try Autopilot setup again.",
  },
  buildResultSchema: (ctx) => turnSchemaWithIds(countingConfigSchema(), ctx),
  validateConfig: validateCountingConfig,
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up a Counting channel (members count up together, " +
    "one number per message, and the count breaks if someone gets it wrong). Each run adds one new " +
    `counting channel. You are setting this up for the server "${ctx.guildName}". Ask ONE short, ` +
    "plain-language question at a time. Never mention field names, JSON, or config, ask like a " +
    "helpful person would. Only ask about things that meaningfully change the outcome (which channel, " +
    "what number to start from, whether to count by more than one at a time, whether simple maths " +
    "like \"12+3\" is allowed, whether the same person can post twice in a row, and whether they want " +
    "milestone celebrations at a regular interval). " +
    NULL_MEANS_UNCHANGED_RULE +
    " " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nEverything a counting channel can do (null = default):\n" +
    "- name: dashboard label (max 80). enabled: false adds it switched off.\n" +
    "- Counting rules: start_at (first number, 0 or more, default 1), step (count by this much, 1 to " +
    "1000, default 1), allow_math (accept simple arithmetic that equals the right number), " +
    "require_alternate_user (the same member can't count twice in a row, default on), " +
    "cooldown_seconds (0 to 3600 between successful counts, default 0), allow_bots (let bots count), " +
    "allow_non_number_messages (leave chat messages that aren't counting attempts alone instead of " +
    "treating them as mistakes), delete_wrong_messages (delete messages that break the count, " +
    "default on).\n" +
    "- Who can count: allowed_roles (only these roles can count, empty = everyone), ignored_roles " +
    "(these roles can't count).\n" +
    "- Mistakes: reset_on_mistake (reset the count when someone breaks it, off for a practice " +
    "channel), reset_to (\"zero\", or \"last_milestone\" which needs milestone_every above 0), " +
    "announce_failure and failure_message (max 300 characters, placeholders {user}, {reason}, " +
    "{number}, {expected}, {restart}, {highest}).\n" +
    "- Milestones and records: milestone_every (celebrate every Nth count, 0 = off), " +
    "announce_milestones and milestone_message (placeholders {user}, {number}, {highest}), " +
    "pin_milestones, economy_milestone_bonus (server currency awarded on a milestone, 0 = off), " +
    "announce_new_record and record_message (placeholders {user}, {number}, {highest}).\n" +
    "- Reactions: success_reaction (on a correct count), failure_reaction (on a mistake), " +
    "milestone_reaction (extra one on a milestone). Each is a unicode emoji, a server emoji name from " +
    "the list below, or \"\" for no reaction.\n" +
    "- Webhook: use_webhook posts the bot's counting messages under a custom name (webhook_name, max " +
    "80) and avatar (webhook_avatar_url, an https image URL).\n" +
    "Only use the placeholders listed for each message, never invent others.\n\n" +
    "Existing text channels (pick channel_id from these ids only):\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    "Existing roles:\n" +
    `${entityList(ctx.roles)}\n\n` +
    "Server emojis (use the name):\n" +
    `${emojiList(ctx.emojis)}\n\n` +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action \"ready\" " +
    "with the config and a short, friendly plain-language summary of the choices you made (leave " +
    "question null). channel_id always needs a real id from the list above, never invent one.",
};
