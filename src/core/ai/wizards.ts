import {
  COMPANION_PERMISSION_SOURCES,
  COMPANION_SETUP_TYPES,
} from "../../config/schemas/companion.js";
import { resolveEmojiByName } from "../emoji.js";

/** Server-side registry of conversational AI setup wizards. Adding AI setup to a new dashboard
 * page later is adding one entry here (plus a trigger button on the website that passes this
 * wizard's id) — no new bridge route, no new gate logic, no new session handling. */

export type AiWizardEntity = { id: string; name: string };
export type AiWizardEmoji = { id: string; name: string; animated: boolean };

export type AiWizardContext = {
  guildName: string;
  voiceChannels: AiWizardEntity[];
  textChannels: AiWizardEntity[];
  categories: AiWizardEntity[];
  roles: AiWizardEntity[];
  emojis: AiWizardEmoji[];
};

export type AiWizardTurn =
  | { action: "ask"; question: string; answerKind: AnswerKind; quickReplies?: string[] | null }
  | { action: "ready"; config: Record<string, unknown>; summary: string };

export type AiWizardDefinition = {
  maxQuestions: number;
  /** A guild-entity list this wizard can't produce a valid result without (e.g. a hub needs a
   * real voice channel to exist). Checked before the first OpenAI call, no wasted spend. */
  requiresEntity?: { kind: keyof Pick<AiWizardContext, "voiceChannels" | "textChannels">; message: string };
  buildSystemPrompt: (ctx: AiWizardContext, questionsAsked: number) => string;
  buildResultSchema: (ctx: AiWizardContext) => Record<string, unknown>;
  /** Server-side sanity check on the model's "ready" config (e.g. does the picked channel id
   * actually exist) — returns an error message if invalid, null if fine. */
  validateConfig?: (config: Record<string, unknown>, ctx: AiWizardContext) => string | null;
};

const COMPANION_REGIONS = [
  "",
  "automatic",
  "us-east",
  "us-west",
  "us-central",
  "rotterdam",
  "brazil",
  "singapore",
  "japan",
  "sydney",
  "india",
];

function entityList(entities: AiWizardEntity[]): string {
  if (entities.length === 0) return "(none)";
  return entities.map((e) => `${e.id}: "${e.name}"`).join("\n");
}

function emojiList(emojis: AiWizardEmoji[]): string {
  if (emojis.length === 0) return "(none)";
  return emojis.map((e) => `"${e.name}"`).join(", ");
}

/** Shared by every "watch messages and react to a match" wizard (Autoreactions, Autothreads,
 * Autoreplies) - kept as one list so the trigger vocabulary never drifts between them. */
const AUTO_TRIGGERS = ["every_message", "contains", "starts_with", "exact", "regex"] as const;

const AUTO_PLACEHOLDER_NOTE =
  "Available placeholders (use naturally, at most a few per line): {user} (mention), " +
  "{user_display} (display name), {guild} (server name), {channel} (mention), {channel_name}, " +
  "{member_count}. Never invent other placeholders.";

const NEVER_EM_DASH_RULE =
  "Never use em dashes in your questions or summary; use a comma, period, or 'and' instead.";

export const ANSWER_KINDS = ["text", "text_channel", "voice_channel", "role"] as const;
export type AnswerKind = (typeof ANSWER_KINDS)[number];

const ANSWER_KIND_RULE =
  "Alongside every question, set answerKind so the dashboard can offer the right picker: " +
  "\"text_channel\" when the answer should be a text channel, \"voice_channel\" when it should be a " +
  "voice channel, \"role\" when it should be a role, or \"text\" for anything else (numbers, style " +
  "choices, yes/no, free text). When action is \"ready\", set answerKind to \"text\" (it is ignored). " +
  "If the user's answer contains a Discord mention like <#123456789012345678> or " +
  "<@&123456789012345678>, that is them using a picker: treat the id inside it as their exact, " +
  "authoritative choice and use it directly instead of matching against the name list. " +
  "Also set quickReplies whenever your question has a small number of natural preset answers (a " +
  "yes/no choice, \"all channels\" vs \"a specific channel\", picking between a few named options " +
  "you just listed, a style choice) so the dashboard can offer tap-to-answer buttons instead of " +
  "making the user type: 2 to 4 short button labels, each one something you would also accept if " +
  "typed verbatim as the answer. Set quickReplies to null when the question genuinely needs free " +
  "text you can't predict (the actual word or phrase to match, message content, a name, a number, " +
  "an emoji). When action is \"ready\", set quickReplies to null (it is ignored).";

function progressInstruction(questionsAsked: number, maxQuestions: number): string {
  const note = `You have asked ${questionsAsked} question(s) so far out of a maximum of ${maxQuestions}. `;
  if (questionsAsked >= maxQuestions) {
    return (
      note +
      "You must respond with action \"ready\" now, filling in anything unresolved with sensible defaults.\n\n"
    );
  }
  return note;
}

function companionSetupSchema(ctx: AiWizardContext): Record<string, unknown> {
  const voiceIds = ctx.voiceChannels.map((c) => c.id);
  const categoryIds = ["", ...ctx.categories.map((c) => c.id)];

  return {
    type: "object",
    properties: {
      name: { type: "string" },
      hub_channel_id: { type: "string", enum: voiceIds.length > 0 ? voiceIds : [""] },
      type: { type: "string", enum: [...COMPANION_SETUP_TYPES] },
      name_template: { type: "string" },
      user_limit: { type: "integer" },
      bitrate: { type: "integer" },
      category_id: { type: "string", enum: categoryIds },
      permission_source: { type: "string", enum: [...COMPANION_PERMISSION_SOURCES] },
      editable: { type: "boolean" },
      auto_text: { type: "boolean" },
      default_lock: { type: "boolean" },
      default_ghost: { type: "boolean" },
      default_nsfw: { type: "boolean" },
      default_status: { type: "string" },
      region: { type: "string", enum: COMPANION_REGIONS },
      dynamic_ready: { type: "integer" },
    },
    required: [
      "name",
      "hub_channel_id",
      "type",
      "name_template",
      "user_limit",
      "bitrate",
      "category_id",
      "permission_source",
      "editable",
      "auto_text",
      "default_lock",
      "default_ghost",
      "default_nsfw",
      "default_status",
      "region",
      "dynamic_ready",
    ],
    additionalProperties: false,
  };
}

function turnSchema(configSchema: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: ["ask", "ready"] },
      question: { type: ["string", "null"] },
      answerKind: { type: "string", enum: [...ANSWER_KINDS] },
      quickReplies: { type: ["array", "null"], items: { type: "string" } },
      summary: { type: ["string", "null"] },
      config: { anyOf: [{ type: "null" }, configSchema] },
    },
    required: ["action", "question", "answerKind", "quickReplies", "summary", "config"],
    additionalProperties: false,
  };
}

function starboardBoardSchema(ctx: AiWizardContext): Record<string, unknown> {
  const textIds = ctx.textChannels.map((c) => c.id);

  return {
    type: "object",
    properties: {
      channel_id: { type: "string", enum: textIds.length > 0 ? textIds : [""] },
      stars_required: { type: "integer" },
      star_emoji: { type: "array", items: { type: "string" } },
      show_star_count: { type: "boolean" },
      copy_full_embed: { type: "boolean" },
      count_self_stars: { type: "boolean" },
    },
    required: [
      "channel_id",
      "stars_required",
      "star_emoji",
      "show_star_count",
      "copy_full_embed",
      "count_self_stars",
    ],
    additionalProperties: false,
  };
}

function countersSchema(ctx: AiWizardContext): Record<string, unknown> {
  const allChannelIds = [...ctx.textChannels, ...ctx.voiceChannels].map((c) => c.id);

  return {
    type: "object",
    properties: {
      name: { type: "string" },
      metric: { type: "string", enum: ["members", "messages", "boosts", "custom"] },
      display: { type: "string", enum: ["message", "channel_name", "voice_name"] },
      channel_id: { type: "string", enum: allChannelIds.length > 0 ? allChannelIds : [""] },
      format: { type: "string" },
      refresh_minutes: { type: "integer" },
      value: { type: "integer" },
    },
    required: ["name", "metric", "display", "channel_id", "format", "refresh_minutes", "value"],
    additionalProperties: false,
  };
}

function countingSchema(ctx: AiWizardContext): Record<string, unknown> {
  const textIds = ctx.textChannels.map((c) => c.id);

  return {
    type: "object",
    properties: {
      name: { type: "string" },
      channel_id: { type: "string", enum: textIds.length > 0 ? textIds : [""] },
      start_at: { type: "integer" },
      step: { type: "integer" },
      allow_math: { type: "boolean" },
      require_alternate_user: { type: "boolean" },
      milestone_every: { type: "integer" },
      reset_on_mistake: { type: "boolean" },
      reset_to: { type: "string", enum: ["zero", "last_milestone"] },
    },
    required: [
      "name",
      "channel_id",
      "start_at",
      "step",
      "allow_math",
      "require_alternate_user",
      "milestone_every",
      "reset_on_mistake",
      "reset_to",
    ],
    additionalProperties: false,
  };
}

const WELCOME_PLACEHOLDER_NOTE =
  "Available placeholders (use naturally, at most a few per line): {user} (mention), " +
  "{user_display} (display name), {user_name} (username), {guild}/{server} (server name), " +
  "{guild_member_count}/{member_count} (member count). Never invent other placeholders.";

function welcomeEmbedMiniSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      title: { type: "string" },
      description: { type: "string" },
      color: { type: "integer" },
    },
    required: ["enabled", "title", "description", "color"],
    additionalProperties: false,
  };
}

function welcomeCardMiniSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      background_type: { type: "string", enum: ["color", "url"] },
      background_color: { type: "integer" },
      background_url: { type: "string" },
      avatar_layout: { type: "string", enum: ["left", "center", "right"] },
      text_layout: { type: "string", enum: ["beside", "below", "overlay_center", "overlay_bottom"] },
      greeting_text: { type: "string" },
      subtitle_text: { type: "string" },
      accent_color: { type: "integer" },
    },
    required: [
      "enabled",
      "background_type",
      "background_color",
      "background_url",
      "avatar_layout",
      "text_layout",
      "greeting_text",
      "subtitle_text",
      "accent_color",
    ],
    additionalProperties: false,
  };
}

function welcomeEventMiniSchema(ctx: AiWizardContext): Record<string, unknown> {
  const textIds = ["", ...ctx.textChannels.map((c) => c.id)];
  return {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      channel_id: { type: "string", enum: textIds },
      content: { type: "string" },
      embed: welcomeEmbedMiniSchema(),
      card: welcomeCardMiniSchema(),
    },
    required: ["enabled", "channel_id", "content", "embed", "card"],
    additionalProperties: false,
  };
}

function welcomeSimpleEventSchema(ctx: AiWizardContext): Record<string, unknown> {
  const textIds = ["", ...ctx.textChannels.map((c) => c.id)];
  return {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      channel_id: { type: "string", enum: textIds },
      content: { type: "string" },
    },
    required: ["enabled", "channel_id", "content"],
    additionalProperties: false,
  };
}

function welcomeSetupSchema(ctx: AiWizardContext): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      join: welcomeEventMiniSchema(ctx),
      leave: welcomeSimpleEventSchema(ctx),
      dm: {
        type: "object",
        properties: { enabled: { type: "boolean" }, content: { type: "string" } },
        required: ["enabled", "content"],
        additionalProperties: false,
      },
      wave_button: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          label: { type: "string" },
          emoji: { type: "string" },
        },
        required: ["enabled", "label", "emoji"],
        additionalProperties: false,
      },
      first_message_react: {
        type: "object",
        properties: { enabled: { type: "boolean" }, emoji: { type: "string" } },
        required: ["enabled", "emoji"],
        additionalProperties: false,
      },
      delete_join_on_early_leave: { type: "boolean" },
    },
    required: ["join", "leave", "dm", "wave_button", "first_message_react", "delete_join_on_early_leave"],
    additionalProperties: false,
  };
}

function passportSetupSchema(ctx: AiWizardContext): Record<string, unknown> {
  const textIds = ["", ...ctx.textChannels.map((c) => c.id)];
  const roleIds = ctx.roles.map((r) => r.id);
  const roleIdsOrEmpty = ["", ...roleIds];

  return {
    type: "object",
    properties: {
      channel_id: { type: "string", enum: textIds },
      unverified_role_id: { type: "string", enum: roleIdsOrEmpty },
      grant_role_ids: { type: "array", items: { type: "string", enum: roleIds.length > 0 ? roleIds : [""] } },
      ping: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          content: { type: "string" },
          button_label: { type: "string" },
        },
        required: ["enabled", "content", "button_label"],
        additionalProperties: false,
      },
      page: {
        type: "object",
        properties: {
          headline: { type: "string" },
          body: { type: "string" },
          rules: { type: "string" },
        },
        required: ["headline", "body", "rules"],
        additionalProperties: false,
      },
      alt_detection: { type: "boolean" },
      min_account_age_seconds: { type: "integer" },
      timeout_action: { type: "string", enum: ["none", "kick"] },
      timeout_seconds: { type: "integer" },
    },
    required: [
      "channel_id",
      "unverified_role_id",
      "grant_role_ids",
      "ping",
      "page",
      "alt_detection",
      "min_account_age_seconds",
      "timeout_action",
      "timeout_seconds",
    ],
    additionalProperties: false,
  };
}

function autoreactionRuleSchema(ctx: AiWizardContext): Record<string, unknown> {
  const textIds = ["", ...ctx.textChannels.map((c) => c.id)];
  return {
    type: "object",
    properties: {
      channel_id: { type: "string", enum: textIds },
      trigger: { type: "string", enum: [...AUTO_TRIGGERS] },
      match: { type: "string" },
      emoji: { type: "string" },
      cooldown_seconds: { type: "integer" },
      attachments_only: { type: "boolean" },
      links_only: { type: "boolean" },
    },
    required: ["channel_id", "trigger", "match", "emoji", "cooldown_seconds", "attachments_only", "links_only"],
    additionalProperties: false,
  };
}

function autothreadRuleSchema(ctx: AiWizardContext): Record<string, unknown> {
  const textIds = ["", ...ctx.textChannels.map((c) => c.id)];
  return {
    type: "object",
    properties: {
      channel_id: { type: "string", enum: textIds },
      thread_name: { type: "string" },
      auto_archive_minutes: { type: "integer", enum: [60, 1440, 4320, 10080] },
      response: { type: "string" },
      trigger: { type: "string", enum: [...AUTO_TRIGGERS] },
      match: { type: "string" },
      cooldown_seconds: { type: "integer" },
      attachments_only: { type: "boolean" },
      links_only: { type: "boolean" },
    },
    required: [
      "channel_id",
      "thread_name",
      "auto_archive_minutes",
      "response",
      "trigger",
      "match",
      "cooldown_seconds",
      "attachments_only",
      "links_only",
    ],
    additionalProperties: false,
  };
}

function autoreplyRuleSchema(ctx: AiWizardContext): Record<string, unknown> {
  const textIds = ["", ...ctx.textChannels.map((c) => c.id)];
  return {
    type: "object",
    properties: {
      channel_id: { type: "string", enum: textIds },
      response: { type: "string" },
      trigger: { type: "string", enum: [...AUTO_TRIGGERS] },
      match: { type: "string" },
      reply_to_message: { type: "boolean" },
      cooldown_seconds: { type: "integer" },
      attachments_only: { type: "boolean" },
      links_only: { type: "boolean" },
    },
    required: [
      "channel_id",
      "response",
      "trigger",
      "match",
      "reply_to_message",
      "cooldown_seconds",
      "attachments_only",
      "links_only",
    ],
    additionalProperties: false,
  };
}

function validateAutoRuleChannel(config: Record<string, unknown>, ctx: AiWizardContext): string | null {
  const channelId = config.channel_id;
  if (typeof channelId === "string" && channelId && !ctx.textChannels.some((c) => c.id === channelId)) {
    return "Autopilot picked a channel that doesn't exist. Please try again.";
  }
  return null;
}

function validateAutoRuleMatch(config: Record<string, unknown>, noun: string): string | null {
  if (config.trigger !== "every_message" && (typeof config.match !== "string" || !config.match.trim())) {
    return `Autopilot's setup was inconsistent (needs a word or phrase to match, unless it ${noun} every message). Please try again.`;
  }
  return null;
}

function validateWelcomeEvent(
  event: unknown,
  ctx: AiWizardContext,
  label: string,
): string | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (!e.enabled) return null;
  const id = e.channel_id;
  if (typeof id !== "string" || !id || !ctx.textChannels.some((c) => c.id === id)) {
    return `Autopilot didn't pick a real channel for the ${label} message. Please try again.`;
  }
  return null;
}

export const AI_WIZARDS: Record<string, AiWizardDefinition> = {
  companion_hub_setup: {
    maxQuestions: 6,
    requiresEntity: {
      kind: "voiceChannels",
      message: "This server has no voice channels yet. Create one first, then try Autopilot setup again.",
    },
    buildResultSchema: (ctx) => turnSchema(companionSetupSchema(ctx)),
    validateConfig: (config, ctx) => {
      const hubChannelId = config.hub_channel_id;
      if (typeof hubChannelId !== "string" || !ctx.voiceChannels.some((c) => c.id === hubChannelId)) {
        return "Autopilot picked a voice channel that doesn't exist. Please try again.";
      }
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up a Companion Channels \"hub\" (a join-to-create " +
      "voice channel: members join it and Dreamliner creates a temporary personal room for them). " +
      `You are setting this up for the server "${ctx.guildName}". ` +
      "Ask ONE short, plain-language question at a time to figure out how they want it configured. " +
      "Never mention field names, JSON, or config, ask like a helpful person would. Only ask about " +
      "things that meaningfully change the outcome (which voice channel, how new rooms should be " +
      "named/created, size limits, and anything else clearly implied by their answers) - don't " +
      "interrogate them on every possible option, use sensible defaults for the rest. " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nExisting voice channels (pick hub_channel_id from these ids only):\n" +
      `${entityList(ctx.voiceChannels)}\n\n` +
      "Existing categories (pick category_id from these ids only, or \"\" to use the hub's own " +
      "category):\n" +
      `${entityList(ctx.categories)}\n\n` +
      "Setup types: default (each person gets a room named after them), sequential (Name 1, Name 2, " +
      "...), predefined (name built from tokens like {user_display}, {seq}, {animals}, {colors}, " +
      "{trees}), clone (new rooms copy the hub's own name/limit/bitrate/region), dynamic (a few empty " +
      "rooms are always kept ready to join instead of created on demand).\n\n" +
      progressInstruction(questionsAsked, 6) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action \"ready\" " +
      "with a fully filled-in config and a short, friendly plain-language summary of the choices you " +
      "made (leave question null). A hub always needs a real hub_channel_id from the list above, " +
      "never invent one.",
  },

  starboard_setup: {
    maxQuestions: 4,
    requiresEntity: {
      kind: "textChannels",
      message: "This server has no text channels yet. Create one first, then try Autopilot setup again.",
    },
    buildResultSchema: (ctx) => turnSchema(starboardBoardSchema(ctx)),
    validateConfig: (config, ctx) => {
      const channelId = config.channel_id;
      if (typeof channelId !== "string" || !ctx.textChannels.some((c) => c.id === channelId)) {
        return "Autopilot picked a channel that doesn't exist. Please try again.";
      }
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up a Starboard \"board\" (when a message gets " +
      "enough star reactions, Dreamliner reposts it to a chosen channel so the best messages get " +
      `highlighted). You are setting this up for the server "${ctx.guildName}". ` +
      "Ask ONE short, plain-language question at a time. Never mention field names, JSON, or " +
      "config, ask like a helpful person would. Only ask about things that meaningfully change the " +
      "outcome (which channel, how many stars are needed, and whether they want a different star " +
      "emoji) - don't interrogate them on every possible option, use sensible defaults for the rest " +
      "(show_star_count true, copy_full_embed true, count_self_stars false, star_emoji [\"\\u2b50\"] " +
      "unless they ask for something else). " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nExisting text channels (pick channel_id from these ids only):\n" +
      `${entityList(ctx.textChannels)}\n\n` +
      progressInstruction(questionsAsked, 4) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action \"ready\" " +
      "with a fully filled-in config and a short, friendly plain-language summary of the choices you " +
      "made (leave question null). A board always needs a real channel_id from the list above, never " +
      "invent one.",
  },

  counters_setup: {
    maxQuestions: 4,
    buildResultSchema: (ctx) => turnSchema(countersSchema(ctx)),
    validateConfig: (config, ctx) => {
      const channelId = config.channel_id;
      const list = config.display === "voice_name" ? ctx.voiceChannels : ctx.textChannels;
      if (typeof channelId !== "string" || !list.some((c) => c.id === channelId)) {
        return "Autopilot picked a channel that doesn't match, or doesn't exist. Please try again.";
      }
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up a live counter (a number shown as a message or " +
      `a channel name, e.g. member count). You are setting this up for the server "${ctx.guildName}". ` +
      "Ask ONE short, plain-language question at a time. Never mention field names, JSON, or config, " +
      "ask like a helpful person would. Find out what they want to count and where they want it " +
      "shown, then use sensible defaults for the rest (format \"{value}\", refresh_minutes 10). " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nWhat it can count (metric): members (server member count, updates automatically), messages " +
      "(total messages sent, updates automatically), boosts (server boost count, updates " +
      "automatically), custom (a number they set themselves from the dashboard, ask for a starting " +
      "value if they pick this).\n\n" +
      "Where it shows (display): message (a message that stays updated in a text channel), " +
      "channel_name (renames a text channel to include the count), voice_name (renames a voice " +
      "channel to include the count). channel_id must be a text channel for message/channel_name, or " +
      "a voice channel for voice_name.\n\n" +
      "Existing text channels:\n" +
      `${entityList(ctx.textChannels)}\n\n` +
      "Existing voice channels:\n" +
      `${entityList(ctx.voiceChannels)}\n\n` +
      progressInstruction(questionsAsked, 4) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action \"ready\" " +
      "with a fully filled-in config and a short, friendly plain-language summary of the choices you " +
      "made (leave question null). channel_id always needs a real id from the lists above matching " +
      "the chosen display, never invent one.",
  },

  counting_setup: {
    maxQuestions: 5,
    requiresEntity: {
      kind: "textChannels",
      message: "This server has no text channels yet. Create one first, then try Autopilot setup again.",
    },
    buildResultSchema: (ctx) => turnSchema(countingSchema(ctx)),
    validateConfig: (config, ctx) => {
      const channelId = config.channel_id;
      if (typeof channelId !== "string" || !ctx.textChannels.some((c) => c.id === channelId)) {
        return "Autopilot picked a channel that doesn't exist. Please try again.";
      }
      if (config.reset_to === "last_milestone" && (typeof config.milestone_every !== "number" || config.milestone_every <= 0)) {
        return "Autopilot's setup was inconsistent (resets to the last milestone but has no milestone interval). Please try again.";
      }
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up a Counting channel (members count up together, " +
      "one number per message, and the count breaks if someone gets it wrong). You are setting this " +
      `up for the server "${ctx.guildName}". Ask ONE short, plain-language question at a time. Never ` +
      "mention field names, JSON, or config, ask like a helpful person would. Only ask about things " +
      "that meaningfully change the outcome (which channel, what number to start from, whether to " +
      "count by more than one at a time, whether simple maths like \"12+3\" should be allowed, whether " +
      "the same person can post twice in a row, and whether they want milestone celebrations at a " +
      "regular interval) - don't interrogate them on every possible option, use sensible defaults for " +
      "the rest (cooldown_seconds 0, allow_bots false, delete_wrong_messages true, reset_on_mistake " +
      "true, reset_to \"zero\" unless milestones are set up, announce_new_record true). " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nExisting text channels (pick channel_id from these ids only):\n" +
      `${entityList(ctx.textChannels)}\n\n` +
      "reset_to \"last_milestone\" is only valid when milestone_every is above 0; otherwise use " +
      "\"zero\".\n\n" +
      progressInstruction(questionsAsked, 5) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action \"ready\" " +
      "with a fully filled-in config and a short, friendly plain-language summary of the choices you " +
      "made (leave question null). channel_id always needs a real id from the list above, never " +
      "invent one.",
  },

  welcome_setup: {
    maxQuestions: 8,
    buildResultSchema: (ctx) => turnSchema(welcomeSetupSchema(ctx)),
    validateConfig: (config, ctx) => {
      return (
        validateWelcomeEvent(config.join, ctx, "join") ??
        validateWelcomeEvent(config.leave, ctx, "leave")
      );
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up Dreamliner's Welcomer: the message sent when a " +
      "member joins (and optionally leaves), an optional private DM, an optional image welcome card, " +
      "a wave button, and a first-message reaction. You are setting this up for the server " +
      `"${ctx.guildName}". Ask ONE short, plain-language question at a time. Never mention field ` +
      "names, JSON, or config, ask like a helpful person would. Focus on: which channel gets the join " +
      "message, what tone they want (casual, hype, chill, formal, matching the server's vibe), whether " +
      "they want it as an embed or a plain message, whether they want an image welcome card and if so " +
      "a rough color or style, and whether they also want a leave message and/or a DM. Only ask about " +
      "the wave button or first-message reaction if it feels natural to bring up, otherwise leave them " +
      "off. Don't interrogate on every option, use sensible defaults for the rest. When you write the " +
      "actual message, embed, or card text, make it warm and specific to this server, never generic " +
      "filler like \"Welcome!\". " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\n" +
      WELCOME_PLACEHOLDER_NOTE +
      "\n\nExisting text channels (pick channel_id from these ids only, or \"\" to leave that event " +
      "off):\n" +
      `${entityList(ctx.textChannels)}\n\n` +
      "Card background_type should be \"color\" unless the user gives you a real image URL to use, in " +
      "which case use \"url\" and put it in background_url. Leave background_url empty otherwise. " +
      "Card and embed text should reuse or riff on the plain message content, not repeat it verbatim.\n\n" +
      progressInstruction(questionsAsked, 8) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action \"ready\" " +
      "with a fully filled-in config and a short, friendly plain-language summary of the choices you " +
      "made (leave question null). Only set embed.enabled or card.enabled to true if the user actually " +
      "wants one; leave.channel_id and dm are optional too, based on what the user said they want.",
  },

  passport_setup: {
    maxQuestions: 6,
    buildResultSchema: (ctx) => turnSchema(passportSetupSchema(ctx)),
    validateConfig: (config, ctx) => {
      const channelId = config.channel_id;
      if (typeof channelId === "string" && channelId && !ctx.textChannels.some((c) => c.id === channelId)) {
        return "Autopilot picked a verify channel that doesn't exist. Please try again.";
      }
      const unverifiedRoleId = config.unverified_role_id;
      if (
        typeof unverifiedRoleId === "string" &&
        unverifiedRoleId &&
        !ctx.roles.some((r) => r.id === unverifiedRoleId)
      ) {
        return "Autopilot picked an unverified role that doesn't exist. Please try again.";
      }
      const grantRoleIds = config.grant_role_ids;
      if (
        !Array.isArray(grantRoleIds) ||
        grantRoleIds.length === 0 ||
        !grantRoleIds.every((id) => typeof id === "string" && ctx.roles.some((r) => r.id === id))
      ) {
        return "Autopilot didn't pick a real role to grant on verification. Please try again.";
      }
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up Dreamliner's Passport (a join-verification gate: " +
      "new members are held behind a role, verify themselves on a web page, then get the real member " +
      `role(s)). You are setting this up for the server "${ctx.guildName}". Ask ONE short, ` +
      "plain-language question at a time. Never mention field names, JSON, or config, ask like a " +
      "helpful person would. You MUST find out which role(s) verified members should receive " +
      "(grant_role_ids, at least one, this is required), and should also ask which role restricts " +
      "unverified members (unverified_role_id) and which channel the join prompt posts in " +
      "(channel_id), if a suitable existing role/channel isn't obvious from context ask about it. " +
      "Also worth asking, briefly: whether they want to kick members who never verify (and after how " +
      "long, e.g. a day or a week), and whether they want alt-account detection on (collects network " +
      "signals at verify time to flag likely alt accounts, mention this is a privacy-relevant choice). " +
      "Only ask about the verify page's headline/body/rules text if it feels natural, otherwise leave " +
      "them as sensible defaults. Don't interrogate on every option. " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nExisting roles (pick unverified_role_id and grant_role_ids from these ids only; never pick " +
      "a role that sounds like a bot/managed role, e.g. named after a bot):\n" +
      `${entityList(ctx.roles)}\n\n` +
      "Existing text channels (pick channel_id from these ids only, or \"\" to skip the join ping " +
      "channel):\n" +
      `${entityList(ctx.textChannels)}\n\n` +
      "If no role in the list looks like a good fit for unverified_role_id, leave it \"\" and say so " +
      "in the summary (the admin can create one and come back). timeout_seconds is only used when " +
      "timeout_action is \"kick\"; use 0 with \"none\" if they don't want a timeout. " +
      "min_account_age_seconds of 0 means no minimum age check.\n\n" +
      progressInstruction(questionsAsked, 6) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action \"ready\" " +
      "with a fully filled-in config and a short, friendly plain-language summary of the choices you " +
      "made (leave question null). grant_role_ids always needs at least one real role id, never leave " +
      "it empty and never invent an id.",
  },

  autoreactions_setup: {
    maxQuestions: 4,
    buildResultSchema: (ctx) => turnSchema(autoreactionRuleSchema(ctx)),
    validateConfig: (config, ctx) => {
      const channelError = validateAutoRuleChannel(config, ctx);
      if (channelError) return channelError;
      const matchError = validateAutoRuleMatch(config, "reacts to");
      if (matchError) return matchError;
      if (typeof config.emoji !== "string" || !config.emoji.trim()) {
        return "Autopilot didn't pick an emoji to react with. Please try again.";
      }
      config.emoji = resolveEmojiByName(config.emoji, ctx.emojis);
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up an Autoreaction (Dreamliner automatically " +
      "reacts to a message with an emoji when it matches). You are setting this up for the server " +
      `"${ctx.guildName}". Ask ONE short, plain-language question at a time. Never mention field ` +
      "names, JSON, or config, ask like a helpful person would. Find out which channel it should " +
      "watch (or all channels), what should trigger the reaction (every message, or only ones " +
      "containing, starting with, or exactly matching a word or phrase, or an advanced regex for " +
      "power users), and which emoji to react with. Only ask about attachments-only, links-only, or " +
      "a cooldown if it feels relevant, otherwise leave them off (false, cooldown_seconds 0). " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nExisting text channels (pick channel_id from these ids only, or \"\" for all channels):\n" +
      `${entityList(ctx.textChannels)}\n\n` +
      "This server's custom emoji: " +
      `${emojiList(ctx.emojis)}. If the user means one of these (even just by saying its name, ` +
      "like \"blahaj\"), put its exact name with no colons in emoji and Dreamliner will use the " +
      "real custom emoji. Otherwise use a literal Unicode emoji character matching what they " +
      "describe. Never invent a custom emoji name that isn't in that list.\n\n" +
      "match is only used for triggers other than every_message; for every_message set it to an " +
      "empty string.\n\n" +
      progressInstruction(questionsAsked, 4) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action " +
      "\"ready\" with a fully filled-in config and a short, friendly plain-language summary of the " +
      "choices you made (leave question null). emoji always needs a real value, never leave it " +
      "empty.",
  },

  autothreads_setup: {
    maxQuestions: 5,
    buildResultSchema: (ctx) => turnSchema(autothreadRuleSchema(ctx)),
    validateConfig: (config, ctx) => {
      const channelError = validateAutoRuleChannel(config, ctx);
      if (channelError) return channelError;
      const matchError = validateAutoRuleMatch(config, "threads");
      if (matchError) return matchError;
      if (typeof config.thread_name !== "string" || !config.thread_name.trim()) {
        return "Autopilot didn't pick a name for the new threads. Please try again.";
      }
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up an Autothread (when a message matches, " +
      "Dreamliner starts a thread on it and can post a message inside). You are setting this up " +
      `for the server "${ctx.guildName}". Ask ONE short, plain-language question at a time. Never ` +
      "mention field names, JSON, or config, ask like a helpful person would. Find out which " +
      "channel it should watch (or all channels), what should trigger a thread (every message, or " +
      "only ones containing, starting with, or exactly matching a word or phrase, or an advanced " +
      "regex for power users), how the new thread should be named, and whether Dreamliner should " +
      "post anything inside it. Only ask about auto-archive time, attachments-only, links-only, or " +
      "a cooldown if it feels relevant, otherwise use sensible defaults (auto_archive_minutes 1440, " +
      "everything else off). " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nExisting text channels (pick channel_id from these ids only, or \"\" for all channels):\n" +
      `${entityList(ctx.textChannels)}\n\n` +
      AUTO_PLACEHOLDER_NOTE +
      " thread_name defaults to \"{user_display}\" if the user has no preference. response can be " +
      "an empty string if they don't want a message posted in the new thread.\n\n" +
      "match is only used for triggers other than every_message; for every_message set it to an " +
      "empty string. auto_archive_minutes must be exactly one of 60, 1440, 4320, or 10080.\n\n" +
      progressInstruction(questionsAsked, 5) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action " +
      "\"ready\" with a fully filled-in config and a short, friendly plain-language summary of the " +
      "choices you made (leave question null). thread_name always needs a real value, never leave " +
      "it empty.",
  },

  autoreplies_setup: {
    maxQuestions: 5,
    buildResultSchema: (ctx) => turnSchema(autoreplyRuleSchema(ctx)),
    validateConfig: (config, ctx) => {
      const channelError = validateAutoRuleChannel(config, ctx);
      if (channelError) return channelError;
      const matchError = validateAutoRuleMatch(config, "replies to");
      if (matchError) return matchError;
      if (typeof config.response !== "string" || !config.response.trim()) {
        return "Autopilot didn't write a reply message. Please try again.";
      }
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up an Autoreply (when a message matches, " +
      "Dreamliner automatically replies with a message). You are setting this up for the server " +
      `"${ctx.guildName}". Ask ONE short, plain-language question at a time. Never mention field ` +
      "names, JSON, or config, ask like a helpful person would. Find out which channel it should " +
      "watch (or all channels), what should trigger a reply (every message, or only ones " +
      "containing, starting with, or exactly matching a word or phrase, or an advanced regex for " +
      "power users), and what the reply should say. When you write the reply, make it warm and " +
      "specific to what was asked, never generic filler. Only ask about replying vs. sending a " +
      "standalone message, attachments-only, links-only, or a cooldown if it feels relevant, " +
      "otherwise use sensible defaults (reply_to_message true, everything else off). " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nExisting text channels (pick channel_id from these ids only, or \"\" for all channels):\n" +
      `${entityList(ctx.textChannels)}\n\n` +
      AUTO_PLACEHOLDER_NOTE +
      "\n\nmatch is only used for triggers other than every_message; for every_message set it to an " +
      "empty string.\n\n" +
      progressInstruction(questionsAsked, 5) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action " +
      "\"ready\" with a fully filled-in config and a short, friendly plain-language summary of the " +
      "choices you made (leave question null). response always needs real text, never leave it " +
      "empty.",
  },
};

export function isKnownAiWizard(wizard: string): wizard is keyof typeof AI_WIZARDS {
  return Object.prototype.hasOwnProperty.call(AI_WIZARDS, wizard);
}
