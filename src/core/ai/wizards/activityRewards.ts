import {
  ACTIVITY_ANNOUNCE_DESTINATIONS,
  ACTIVITY_METRICS,
  MAX_ACTIVITY_MILESTONES,
} from "../../../config/schemas/activityRewards.js";
import { WELCOME_MILESTONE_MESSAGE_MODES } from "../../../config/schemas/welcome.js";
import {
  ANSWER_KIND_RULE,
  COLOR_RULE,
  FULL_PLACEHOLDER_NOTE,
  NEVER_EM_DASH_RULE,
  NULL_MEANS_UNCHANGED_RULE,
  bool,
  clampInt,
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
  welcomeCardSchema,
  welcomeEmbedSchema,
  type AiWizardContext,
  type AiWizardDefinition,
} from "../wizardKit.js";

const MAX_QUESTIONS = 6;
const MAX_MILESTONE_ROLES = 10;

const ACTIVITY_PLACEHOLDER_NOTE =
  "Activity placeholders: {milestone} (the milestone's label, e.g. \"1,000 messages\"), " +
  "{milestone_requirement} (the requirement even when the milestone has a name), {messages} (their " +
  "message count), {voice_time} (their voice time, e.g. \"12h 30m\"), {voice_hours} (voice hours as a " +
  "number), {reward_roles} (the roles they got, listed without pinging), {next_milestone} (the next " +
  "milestone on the same ladder, empty when there is none). " +
  FULL_PLACEHOLDER_NOTE;

function richMessageSchema(): Record<string, unknown> {
  return obj({
    content: nullable(str()),
    embed: nullable(welcomeEmbedSchema()),
    card: nullable(welcomeCardSchema()),
  });
}

function milestoneSchema(): Record<string, unknown> {
  return obj({
    metric: oneOf(ACTIVITY_METRICS),
    threshold: int(),
    name: nullable(str()),
    enabled: nullable(bool()),
    roles: nullable(idArray("role")),
    remove_roles: nullable(idArray("role")),
    announce: nullable(bool()),
    channel_id: nullable(idOrEmpty("text_channel")),
    message_mode: nullable(oneOf(WELCOME_MILESTONE_MESSAGE_MODES)),
    message: nullable(richMessageSchema()),
  });
}

/** Text channels, voice channels and categories all count as "ignored channels" for this plugin. */
function anyChannelArray(): Record<string, unknown> {
  return {
    type: "array",
    items: { anyOf: [idRef("text_channel"), idRef("voice_channel"), idRef("category")] },
  };
}

export function activityRewardsConfigSchema(): Record<string, unknown> {
  return obj({
    milestones: { type: "array", items: milestoneSchema() },
    stacking: nullable(bool()),
    announcement: nullable(
      obj({
        enabled: nullable(bool()),
        destination: nullable(oneOf(ACTIVITY_ANNOUNCE_DESTINATIONS)),
        channel_id: nullable(idOrEmpty("text_channel")),
        content: nullable(str()),
        embed: nullable(welcomeEmbedSchema()),
        card: nullable(welcomeCardSchema()),
      }),
    ),
    message_cooldown_seconds: nullable(int()),
    min_message_length: nullable(int()),
    ignored_channels: nullable(anyChannelArray()),
    ignored_roles: nullable(idArray("role")),
    voice_require_others: nullable(bool()),
    voice_ignore_muted: nullable(bool()),
    voice_ignore_afk: nullable(bool()),
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeRichMessage(value: unknown): Record<string, unknown> | null {
  if (!isObject(value)) return null;
  return {
    content: typeof value.content === "string" ? value.content.slice(0, 2000) : null,
    embed: isObject(value.embed) ? value.embed : null,
    card: isObject(value.card) ? value.card : null,
  };
}

function keepAnyChannelIds(value: unknown, ctx: AiWizardContext): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return [];
  const known = new Set([...ctx.textChannels, ...ctx.voiceChannels, ...ctx.categories].map((c) => c.id));
  return [...new Set(value.filter((v): v is string => typeof v === "string" && known.has(v)))];
}

export function validateActivityRewardsConfig(config: Record<string, unknown>, ctx: AiWizardContext): string | null {
  const raw = Array.isArray(config.milestones) ? config.milestones.filter(isObject) : [];
  // Same metric + threshold twice in one result: the later entry wins (it edits the same milestone).
  const byKey = new Map<string, Record<string, unknown>>();
  for (const m of raw) {
    const metric = m.metric === "voice_minutes" ? "voice_minutes" : "messages";
    const threshold = clampInt(m.threshold, 1, 100_000_000) ?? 1;
    const channelId = m.channel_id;
    byKey.set(`${metric}:${threshold}`, {
      metric,
      threshold,
      name: typeof m.name === "string" ? m.name.trim().slice(0, 80) : null,
      enabled: typeof m.enabled === "boolean" ? m.enabled : null,
      roles: keepIds(m.roles, ctx, "role")?.slice(0, MAX_MILESTONE_ROLES) ?? null,
      remove_roles: keepIds(m.remove_roles, ctx, "role")?.slice(0, MAX_MILESTONE_ROLES) ?? null,
      announce: typeof m.announce === "boolean" ? m.announce : null,
      channel_id: typeof channelId === "string" && validId(channelId, ctx, "text_channel") ? channelId : null,
      message_mode: m.message_mode === "custom" || m.message_mode === "default" ? m.message_mode : null,
      message: sanitizeRichMessage(m.message),
    });
  }
  config.milestones = [...byKey.values()].slice(0, MAX_ACTIVITY_MILESTONES);

  if (config.announcement !== null && config.announcement !== undefined) {
    if (!isObject(config.announcement)) {
      config.announcement = null;
    } else {
      const a = config.announcement;
      if (a.channel_id !== null && !validId(a.channel_id, ctx, "text_channel")) {
        return "Autopilot picked an announcement channel that doesn't exist. Please try again.";
      }
      if (a.enabled !== false && a.destination === "channel" && a.channel_id === "") {
        return "Autopilot chose a fixed announcement channel but didn't pick one. Please try again.";
      }
      if (typeof a.content === "string") a.content = a.content.slice(0, 2000);
      if (!isObject(a.embed)) a.embed = null;
      if (!isObject(a.card)) a.card = null;
    }
  }

  config.message_cooldown_seconds = clampInt(config.message_cooldown_seconds, 0, 3600);
  config.min_message_length = clampInt(config.min_message_length, 0, 2000);
  config.ignored_channels = keepAnyChannelIds(config.ignored_channels, ctx);
  config.ignored_roles = keepIds(config.ignored_roles, ctx, "role");
  return null;
}

export const activityRewardsWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 4000,
  buildResultSchema: (ctx) => turnSchemaWithIds(activityRewardsConfigSchema(), ctx),
  validateConfig: validateActivityRewardsConfig,
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up Activity Rewards: as members chat and hang out " +
    "in voice channels, Dreamliner counts their messages and voice time and, when they reach a " +
    "milestone the admin sets up (for example 100 messages, 1,000 messages, or 10 hours in voice), " +
    "gives them roles and posts a congratulations message. Messages and voice time are separate " +
    `ladders. You are setting this up for the server "${ctx.guildName}". Ask ONE short, ` +
    "plain-language question at a time. Never mention field names, JSON, or config, ask like a " +
    "helpful person would. Cover, in roughly this order: what they want to reward (chatting, " +
    "voice time, or both); the milestones and which role each one gives (suggest a sensible " +
    "ladder like 100 / 500 / 1,000 / 5,000 messages or 1 / 10 / 50 hours in voice, and match " +
    "roles by name when the server already has fitting ones, e.g. roles called Active, Regular, " +
    "Veteran or Level 10; ask which role goes with which milestone when it's unclear); whether " +
    "members keep every milestone role they earn or only their highest one; and where the " +
    "congratulations message should go. " +
    NULL_MEANS_UNCHANGED_RULE +
    " " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nWhat Activity Rewards can do:\n" +
    "- Milestones (up to 50): each is a metric (\"messages\", threshold = number of messages, or " +
    "\"voice_minutes\", threshold = minutes in voice, so 10 hours is 600) with an optional short name " +
    "(e.g. \"Regular\", empty shows the requirement instead), up to 10 roles to give, up to 10 roles " +
    "to take away (e.g. a starter or newcomer role), an on/off switch, whether it is announced at all, " +
    "an optional channel just for its announcement (\"\" uses the default destination), and either the " +
    "shared announcement (message_mode \"default\") or its own message (message_mode \"custom\" with " +
    "message content, embed and image card).\n" +
    "- A milestone with the same metric and threshold as an existing one EDITS that milestone: only " +
    "its non-null fields change. Use that when the user wants to change an existing milestone. " +
    "Leave milestones as an empty list when the user only wants to change other settings. For a new " +
    "milestone, null fields get the defaults (enabled, announced, no roles). Inside each milestone, " +
    "set every field the user didn't mention to null, never [] or \"\" (those would clear it).\n" +
    "- stacking: true = members keep every milestone role they earn, false = only their highest " +
    "role per ladder. Keep it null unless the user chose.\n" +
    "- announcement: the shared congratulations message. enabled turns announcements on or off; " +
    "destination is \"current\" (where the member was active, falling back to channel_id), " +
    "\"channel\" (always channel_id, which must then be set), or \"dm\"; content is the message text " +
    "(max 2000 characters, one short upbeat line specific to this server works well); it can also " +
    "carry an embed and a generated image card (greeting and subtitle text, colors, layout). " +
    "Set announcement to null to leave it all as it is.\n" +
    "- Tracking rules: message_cooldown_seconds (0 to 3600, only one message per member counts in " +
    "that window, default 30), min_message_length (0 to 2000, ignore shorter messages), " +
    "ignored_channels (text channels, voice channels or whole categories where activity never " +
    "counts), ignored_roles (members with these roles never progress), voice_require_others (only " +
    "count voice time with at least one other person present), voice_ignore_muted (skip time while " +
    "muted or deafened), voice_ignore_afk (skip time in the AFK channel).\n\n" +
    ACTIVITY_PLACEHOLDER_NOTE +
    " " +
    COLOR_RULE +
    "\n\nExisting roles (pick roles from these ids only; never pick a role that sounds like a " +
    "bot/managed role, e.g. named after a bot, or @everyone):\n" +
    `${entityList(ctx.roles)}\n\n` +
    "Existing text channels:\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    "Existing voice channels:\n" +
    `${entityList(ctx.voiceChannels)}\n\n` +
    "Existing categories:\n" +
    `${entityList(ctx.categories)}\n\n` +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action " +
    "\"ready\" with the config and a short, friendly plain-language summary of the choices you " +
    "made (leave question null). Never invent ids.",
};
