import {
  COMPANION_PERMISSION_SOURCES,
  COMPANION_SETUP_TYPES,
} from "../../config/schemas/companion.js";
import { AUTOMOD_PRESETS } from "../../config/schemas/automod.js";
import { TICKET_BUTTON_STYLES, TICKET_CONTAINER_MODES, TICKET_PANEL_STYLES } from "../../config/schemas/tickets.js";
import { SUGGESTION_MODES } from "../../config/schemas/suggestions.js";
import { IMAGE_SOURCES, isValidTimeZone } from "../../config/schemas/images.js";
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

/** Mirrors AUTOMOD_GROUP_LABELS in src/plugins/automod/catalog.ts - kept as a small local copy
 * (rather than importing plugin code into core) since it only needs the group ids/labels, and a
 * hand-configured Automod wizard is scoped to picking a preset plus which broad categories to
 * force on, not walking through all 22 individual rules conversationally. */
const AUTOMOD_GROUPS = ["content", "spam", "mentions_links", "presentation", "images", "raid"] as const;
const AUTOMOD_GROUP_LABELS: Record<(typeof AUTOMOD_GROUPS)[number], string> = {
  content: "Content filters (profanity, slurs, custom word/phrase filters)",
  spam: "Spam & noise (message spam, duplicate/copypasta, attachment/emoji/sticker spam)",
  mentions_links: "Mentions & links (mass mentions, @everyone/@here, invite links, link spam)",
  presentation: "Presentation (excessive caps, zalgo/obfuscated text)",
  images: "Image scanning (known scam-image reposts)",
  raid: "Join protection (raid-like bursts of new members)",
};

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

function imageDailySendSchema(ctx: AiWizardContext): Record<string, unknown> {
  const textIds = ctx.textChannels.map((c) => c.id);
  return {
    type: "object",
    properties: {
      channel_id: { type: "string", enum: textIds.length > 0 ? textIds : [""] },
      source: { type: "string", enum: [...IMAGE_SOURCES] },
      time: { type: "string" },
      timezone: { type: "string" },
    },
    required: ["channel_id", "source", "time", "timezone"],
    additionalProperties: false,
  };
}

function slowmodeSetupSchema(ctx: AiWizardContext): Record<string, unknown> {
  const roleIds = ["", ...ctx.roles.map((r) => r.id)];
  const textIds = ["", ...ctx.textChannels.map((c) => c.id)];
  return {
    type: "object",
    properties: {
      individual_enabled: { type: "boolean" },
      allow_manage_messages_bypass: { type: "boolean" },
      individual_default_seconds: { type: "integer" },
      rule_role_id: { type: "string", enum: roleIds },
      rule_seconds: { type: "integer" },
      rule_channel_id: { type: "string", enum: textIds },
    },
    required: [
      "individual_enabled",
      "allow_manage_messages_bypass",
      "individual_default_seconds",
      "rule_role_id",
      "rule_seconds",
      "rule_channel_id",
    ],
    additionalProperties: false,
  };
}

function automodSetupSchema(ctx: AiWizardContext): Record<string, unknown> {
  const textIds = ["", ...ctx.textChannels.map((c) => c.id)];
  return {
    type: "object",
    properties: {
      preset: { type: "string", enum: [...AUTOMOD_PRESETS] },
      categories: { type: "array", items: { type: "string", enum: [...AUTOMOD_GROUPS] } },
      native_enabled: { type: "boolean" },
      log_channel_id: { type: "string", enum: textIds },
    },
    required: ["preset", "categories", "native_enabled", "log_channel_id"],
    additionalProperties: false,
  };
}

function persistStickySchema(ctx: AiWizardContext): Record<string, unknown> {
  const textIds = ctx.textChannels.map((c) => c.id);
  return {
    type: "object",
    properties: {
      channel_id: { type: "string", enum: textIds.length > 0 ? textIds : [""] },
      name: { type: "string" },
      content: { type: "string" },
      delay_seconds: { type: "integer" },
      message_threshold: { type: "integer" },
    },
    required: ["channel_id", "name", "content", "delay_seconds", "message_threshold"],
    additionalProperties: false,
  };
}

function autodeleteRuleSchema(ctx: AiWizardContext): Record<string, unknown> {
  const textIds = ctx.textChannels.map((c) => c.id);
  return {
    type: "object",
    properties: {
      channel_id: { type: "string", enum: textIds.length > 0 ? textIds : [""] },
      name: { type: "string" },
      delay_seconds: { type: "integer" },
    },
    required: ["channel_id", "name", "delay_seconds"],
    additionalProperties: false,
  };
}

function autoroleEntrySchema(ctx: AiWizardContext): Record<string, unknown> {
  const roleIds = ctx.roles.map((r) => r.id);
  return {
    type: "object",
    properties: {
      audience: { type: "string", enum: ["human", "bot"] },
      role_id: { type: "string", enum: roleIds.length > 0 ? roleIds : [""] },
      delay_seconds: { type: "integer" },
    },
    required: ["audience", "role_id", "delay_seconds"],
    additionalProperties: false,
  };
}

function memberIdentitySetupSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      restore_nickname: { type: "boolean" },
      restore_roles: { type: "boolean" },
      restore_timeout: { type: "boolean" },
      skip_managed_roles: { type: "boolean" },
      delay_seconds: { type: "integer" },
    },
    required: ["restore_nickname", "restore_roles", "restore_timeout", "skip_managed_roles", "delay_seconds"],
    additionalProperties: false,
  };
}

function rolePanelSetupSchema(ctx: AiWizardContext): Record<string, unknown> {
  const textIds = ctx.textChannels.map((c) => c.id);
  const roleIds = ctx.roles.map((r) => r.id);
  return {
    type: "object",
    properties: {
      name: { type: "string" },
      trigger_type: { type: "string", enum: ["reaction", "button"] },
      selection_mode: { type: "string", enum: ["multiple", "single"] },
      channel_id: { type: "string", enum: textIds.length > 0 ? textIds : [""] },
      content: { type: "string" },
      roles: {
        type: "array",
        items: {
          type: "object",
          properties: {
            role_id: { type: "string", enum: roleIds.length > 0 ? roleIds : [""] },
            emoji: { type: "string" },
            label: { type: "string" },
          },
          required: ["role_id", "emoji", "label"],
          additionalProperties: false,
        },
      },
    },
    required: ["name", "trigger_type", "selection_mode", "channel_id", "content", "roles"],
    additionalProperties: false,
  };
}

function boosterRoleTierSchema(ctx: AiWizardContext): Record<string, unknown> {
  const roleIds = ctx.roles.map((r) => r.id);
  return {
    type: "object",
    properties: {
      stacking: { type: "boolean" },
      name: { type: "string" },
      role_id: { type: "string", enum: roleIds.length > 0 ? roleIds : [""] },
      duration_days: { type: "integer" },
    },
    required: ["stacking", "name", "role_id", "duration_days"],
    additionalProperties: false,
  };
}

function tagSetupSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      name: { type: "string" },
      content: { type: "string" },
    },
    required: ["name", "content"],
    additionalProperties: false,
  };
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

function giveawaysSetupSchema(ctx: AiWizardContext): Record<string, unknown> {
  const textIdsOrEmpty = ["", ...ctx.textChannels.map((c) => c.id)];
  const roleIdsOrEmpty = ["", ...ctx.roles.map((r) => r.id)];

  return {
    type: "object",
    properties: {
      log_channel_id: { type: "string", enum: textIdsOrEmpty },
      default_entry_method: { type: "string", enum: ["button", "reaction"] },
      default_reaction_emoji: { type: "string" },
      default_button_label: { type: "string" },
      default_button_emoji: { type: "string" },
      default_button_style: { type: "string", enum: [...TICKET_BUTTON_STYLES] },
      default_winner_count: { type: "integer" },
      default_dm_winner: { type: "boolean" },
      default_dm_non_winners: { type: "boolean" },
      default_claim_window_minutes: { type: "integer" },
      default_require_role_mode: { type: "string", enum: ["any", "all"] },
      default_booster_bonus_weight: { type: "number" },
      default_entry_cost: { type: "number" },
      default_win_bonus: { type: "number" },
      ping_role_id: { type: "string", enum: roleIdsOrEmpty },
    },
    required: [
      "log_channel_id",
      "default_entry_method",
      "default_reaction_emoji",
      "default_button_label",
      "default_button_emoji",
      "default_button_style",
      "default_winner_count",
      "default_dm_winner",
      "default_dm_non_winners",
      "default_claim_window_minutes",
      "default_require_role_mode",
      "default_booster_bonus_weight",
      "default_entry_cost",
      "default_win_bonus",
      "ping_role_id",
    ],
    additionalProperties: false,
  };
}

function suggestionsSetupSchema(ctx: AiWizardContext): Record<string, unknown> {
  const textIds = ctx.textChannels.map((c) => c.id);
  const textIdsOrEmpty = ["", ...textIds];

  return {
    type: "object",
    properties: {
      mode: { type: "string", enum: [...SUGGESTION_MODES] },
      suggestions_channel_id: { type: "string", enum: textIds.length > 0 ? textIds : [""] },
      review_channel_id: { type: "string", enum: textIdsOrEmpty },
      anonymous: { type: "boolean" },
      cooldown: { type: "string" },
      min_messages: { type: "integer" },
      min_account_age: { type: "string" },
      voting_enabled: { type: "boolean" },
      allow_attachments: { type: "boolean" },
    },
    required: [
      "mode",
      "suggestions_channel_id",
      "review_channel_id",
      "anonymous",
      "cooldown",
      "min_messages",
      "min_account_age",
      "voting_enabled",
      "allow_attachments",
    ],
    additionalProperties: false,
  };
}

function ticketsSetupSchema(ctx: AiWizardContext): Record<string, unknown> {
  const roleIds = ctx.roles.map((r) => r.id);
  const roleIdsForArray = roleIds.length > 0 ? roleIds : [""];
  const textIds = ctx.textChannels.map((c) => c.id);
  const textIdsOrEmpty = ["", ...textIds];
  const categoryIdsOrEmpty = ["", ...ctx.categories.map((c) => c.id)];

  return {
    type: "object",
    properties: {
      staff_role_ids: { type: "array", items: { type: "string", enum: roleIdsForArray } },
      log_channel_id: { type: "string", enum: textIdsOrEmpty },
      default_transcript_channel_id: { type: "string", enum: textIdsOrEmpty },
      dm_transcript_on_close: { type: "boolean" },
      panel_name: { type: "string" },
      panel_channel_id: { type: "string", enum: textIds.length > 0 ? textIds : [""] },
      panel_style: { type: "string", enum: [...TICKET_PANEL_STYLES] },
      panel_content: { type: "string" },
      panel_embed_title: { type: "string" },
      panel_embed_description: { type: "string" },
      category_label: { type: "string" },
      category_description: { type: "string" },
      category_emoji: { type: "string" },
      category_button_style: { type: "string", enum: [...TICKET_BUTTON_STYLES] },
      category_channel_id: { type: "string", enum: categoryIdsOrEmpty },
      category_mode: { type: "string", enum: [...TICKET_CONTAINER_MODES] },
      category_naming_pattern: { type: "string" },
      category_welcome_message: { type: "string" },
      category_support_role_ids: { type: "array", items: { type: "string", enum: roleIdsForArray } },
    },
    required: [
      "staff_role_ids",
      "log_channel_id",
      "default_transcript_channel_id",
      "dm_transcript_on_close",
      "panel_name",
      "panel_channel_id",
      "panel_style",
      "panel_content",
      "panel_embed_title",
      "panel_embed_description",
      "category_label",
      "category_description",
      "category_emoji",
      "category_button_style",
      "category_channel_id",
      "category_mode",
      "category_naming_pattern",
      "category_welcome_message",
      "category_support_role_ids",
    ],
    additionalProperties: false,
  };
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

  images_setup: {
    maxQuestions: 4,
    requiresEntity: {
      kind: "textChannels",
      message: "This server has no text channels yet. Create one first, then try Autopilot setup again.",
    },
    buildResultSchema: (ctx) => turnSchema(imageDailySendSchema(ctx)),
    validateConfig: (config, ctx) => {
      const channelId = config.channel_id;
      if (typeof channelId !== "string" || !ctx.textChannels.some((c) => c.id === channelId)) {
        return "Autopilot picked a channel that doesn't exist. Please try again.";
      }
      if (typeof config.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(config.time)) {
        return "Autopilot picked a time that isn't valid. Please try again.";
      }
      if (typeof config.timezone !== "string" || !isValidTimeZone(config.timezone)) {
        return "Autopilot picked a timezone that isn't valid. Please try again.";
      }
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up a Daily Image: once a day, Dreamliner posts a " +
      "fresh random image into a chosen channel. The kinds are: \"anime\" (anime art: nekos, " +
      "waifus, kitsunes, husbandos), \"blahaj\" (photos of the IKEA Blåhaj shark plush), and " +
      "animal photos: \"cat\", \"dog\", \"fox\", \"duck\", \"capybara\", \"bird\". You are " +
      "setting this up for the server " +
      `"${ctx.guildName}". Ask ONE short, plain-language question at a time. Never mention field ` +
      "names, JSON, or config, ask like a helpful person would. Find out which kind of image, which " +
      "channel it should post in, and what time of day. If the channel name or the user's wording " +
      "already makes the kind of image obvious, don't ask about it. " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nExisting text channels (pick channel_id from these ids only):\n" +
      `${entityList(ctx.textChannels)}\n\n` +
      "time is 24-hour \"HH:MM\" (e.g. \"09:00\", \"18:30\"); turn answers like \"9am\" or " +
      "\"evening\" into a sensible exact time, defaulting to \"12:00\". timezone is an IANA " +
      "timezone name like \"Europe/London\", \"America/New_York\", or \"Asia/Tokyo\". When the user " +
      "gives a time, ask which timezone (or city/country) they mean unless they already said, and " +
      "map their answer to the matching IANA name. Use \"UTC\" if they have no preference.\n\n" +
      progressInstruction(questionsAsked, 4) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action " +
      "\"ready\" with a fully filled-in config and a short, friendly plain-language summary of the " +
      "choices you made (leave question null). channel_id always needs a real channel id, never " +
      "leave it empty.",
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

  slowmode_setup: {
    maxQuestions: 5,
    buildResultSchema: (ctx) => turnSchema(slowmodeSetupSchema(ctx)),
    validateConfig: (config, ctx) => {
      const roleId = config.rule_role_id;
      if (typeof roleId === "string" && roleId && !ctx.roles.some((r) => r.id === roleId)) {
        return "Autopilot picked a role that doesn't exist. Please try again.";
      }
      const channelId = config.rule_channel_id;
      if (typeof channelId === "string" && channelId && !ctx.textChannels.some((c) => c.id === channelId)) {
        return "Autopilot picked a channel that doesn't exist. Please try again.";
      }
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up Slowmode's individual limits: a bot-enforced " +
      "cooldown between messages for specific people or roles, separate from Discord's own " +
      "built-in per-channel slowmode (that one is set with /slowmode set, not through this " +
      `wizard). You are setting this up for the server "${ctx.guildName}". Ask ONE short, ` +
      "plain-language question at a time. Never mention field names, JSON, or config, ask like a " +
      "helpful person would. Find out: whether they want individual (per-member) slowmode turned " +
      "on at all, how many seconds someone should wait between messages by default when no more " +
      "specific rule applies (0 means off), whether members with Manage Messages should skip it " +
      "entirely, and whether a particular role should get its own different delay (for example, " +
      "new members posting slower than everyone else). Only ask about the role-specific rule if it " +
      "feels relevant, otherwise leave rule_role_id empty. " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nExisting roles (pick rule_role_id from these ids only, or \"\" to skip a role-specific " +
      "rule):\n" +
      `${entityList(ctx.roles)}\n\n` +
      "Existing text channels (pick rule_channel_id from these ids only, or \"\" for all channels, " +
      "only relevant if rule_role_id is set):\n" +
      `${entityList(ctx.textChannels)}\n\n` +
      progressInstruction(questionsAsked, 5) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action " +
      "\"ready\" with a fully filled-in config and a short, friendly plain-language summary of the " +
      "choices you made (leave question null).",
  },

  automod_setup: {
    maxQuestions: 5,
    buildResultSchema: (ctx) => turnSchema(automodSetupSchema(ctx)),
    validateConfig: (config, ctx) => {
      const channelId = config.log_channel_id;
      if (typeof channelId === "string" && channelId && !ctx.textChannels.some((c) => c.id === channelId)) {
        return "Autopilot picked a log channel that doesn't exist. Please try again.";
      }
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up Automod: Dreamliner scans messages and can " +
      "automatically act (delete, warn, timeout, kick, or ban) on things like profanity/slurs, " +
      "spam, invite/link spam, mass mentions, and raid-like bursts of new members. It can also " +
      "mirror some of the same rules into Discord's own native AutoMod for extra resilience if the " +
      `bot ever goes down. You are setting this up for the server "${ctx.guildName}". Ask ONE ` +
      "short, plain-language question at a time. Never mention field names, JSON, or config, ask " +
      "like a helpful person would. Find out: how strict they want it overall (light, standard, or " +
      "strict), which of the categories below matter most to this server (they can name several, " +
      "or say \"everything\"), whether they also want native Discord AutoMod mirroring turned on, " +
      "and which channel (if any) should get a log of what Automod catches. " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nCategories (pick zero or more for categories, matching what the user says matters most " +
      "to them; the chosen preset already gives sensible defaults, this only makes sure their " +
      "priorities are definitely turned on):\n" +
      Object.entries(AUTOMOD_GROUP_LABELS)
        .map(([id, label]) => `"${id}": ${label}`)
        .join("\n") +
      "\n\nExisting text channels (pick log_channel_id from these ids only, or \"\" for no log):\n" +
      `${entityList(ctx.textChannels)}\n\n` +
      progressInstruction(questionsAsked, 5) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action " +
      "\"ready\" with a fully filled-in config and a short, friendly plain-language summary of the " +
      "choices you made (leave question null). preset always needs a real value, default to " +
      "\"standard\" if the user has no preference.",
  },

  persist_setup: {
    maxQuestions: 5,
    requiresEntity: {
      kind: "textChannels",
      message: "This server has no text channels yet. Create one first, then try Autopilot setup again.",
    },
    buildResultSchema: (ctx) => turnSchema(persistStickySchema(ctx)),
    validateConfig: (config, ctx) => {
      const channelId = config.channel_id;
      if (typeof channelId !== "string" || !ctx.textChannels.some((c) => c.id === channelId)) {
        return "Autopilot picked a channel that doesn't exist. Please try again.";
      }
      if (typeof config.content !== "string" || !config.content.trim()) {
        return "Autopilot didn't write a sticky message. Please try again.";
      }
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up Persist: a \"sticky\" message that Dreamliner " +
      "keeps at the bottom of a channel, reposting it automatically once things go quiet or enough " +
      "new messages pile up, so it never gets buried (common uses: channel rules, a support " +
      `pointer, an ongoing announcement). You are setting this up for the server "${ctx.guildName}". ` +
      "Ask ONE short, plain-language question at a time. Never mention field names, JSON, or " +
      "config, ask like a helpful person would. Find out which channel, and what the sticky should " +
      "say. When you write the message, make it warm and specific to what was asked, never generic " +
      "filler. Only ask about the resend timing (how long to wait quietly before reposting, and/or " +
      "how many other messages should go by first) if it feels relevant, otherwise use sensible " +
      "defaults (delay_seconds 10, message_threshold 0). " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nExisting text channels (pick channel_id from these ids only):\n" +
      `${entityList(ctx.textChannels)}\n\n` +
      AUTO_PLACEHOLDER_NOTE +
      "\n\nBoth resend conditions apply together when both are set above 0 (it waits for whichever " +
      "finishes last). name is a short label for the dashboard list and can be left empty.\n\n" +
      progressInstruction(questionsAsked, 5) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action " +
      "\"ready\" with a fully filled-in config and a short, friendly plain-language summary of the " +
      "choices you made (leave question null). content always needs real text, never leave it " +
      "empty.",
  },

  autodelete_setup: {
    maxQuestions: 4,
    requiresEntity: {
      kind: "textChannels",
      message: "This server has no text channels yet. Create one first, then try Autopilot setup again.",
    },
    buildResultSchema: (ctx) => turnSchema(autodeleteRuleSchema(ctx)),
    validateConfig: (config, ctx) => {
      const channelId = config.channel_id;
      if (typeof channelId !== "string" || !ctx.textChannels.some((c) => c.id === channelId)) {
        return "Autopilot picked a channel that doesn't exist. Please try again.";
      }
      if (typeof config.delay_seconds !== "number" || config.delay_seconds < 1) {
        return "Autopilot's setup was inconsistent (needs a delay of at least a second). Please try again.";
      }
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up Autodelete: Dreamliner automatically deletes " +
      "every message posted in a chosen channel after a delay (common uses: a bot-command channel, " +
      "a giveaway-entry channel, anywhere that shouldn't build up a permanent history). You are " +
      `setting this up for the server "${ctx.guildName}". Ask ONE short, plain-language question at ` +
      "a time. Never mention field names, JSON, or config, ask like a helpful person would. Find " +
      "out which channel, and how long to wait before deleting (a few seconds, a minute, an hour, " +
      "a day, up to a week maximum). " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nExisting text channels (pick channel_id from these ids only):\n" +
      `${entityList(ctx.textChannels)}\n\n` +
      "delay_seconds must be at least 1 and at most 604800 (7 days). name is a short label for the " +
      "dashboard list and can be left empty.\n\n" +
      progressInstruction(questionsAsked, 4) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action " +
      "\"ready\" with a fully filled-in config and a short, friendly plain-language summary of the " +
      "choices you made (leave question null).",
  },

  autorole_setup: {
    maxQuestions: 4,
    buildResultSchema: (ctx) => turnSchema(autoroleEntrySchema(ctx)),
    validateConfig: (config, ctx) => {
      const roleId = config.role_id;
      if (typeof roleId !== "string" || !roleId || !ctx.roles.some((r) => r.id === roleId)) {
        return "Autopilot didn't pick a real role to grant. Please try again.";
      }
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up Autorole: Dreamliner automatically gives a " +
      "role to new members the moment they join, optionally after a short delay, with separate " +
      `lists for humans and bots. You are setting this up for the server "${ctx.guildName}". Ask ` +
      "ONE short, plain-language question at a time. Never mention field names, JSON, or config, " +
      "ask like a helpful person would. Find out: is this for humans or bots joining, which role " +
      "to grant, and whether to wait before granting it (immediately, or after a short delay, for " +
      "example to let a verification step or another bot's setup finish first). " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nExisting roles (pick role_id from these ids only; never pick a role that sounds like a " +
      "bot/managed role, e.g. named after a bot, unless the user is explicitly setting up the bot " +
      "audience):\n" +
      `${entityList(ctx.roles)}\n\n` +
      "delay_seconds is 0 for immediate, or however many seconds to wait otherwise (convert a " +
      "natural answer like \"5 minutes\" to seconds yourself).\n\n" +
      progressInstruction(questionsAsked, 4) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action " +
      "\"ready\" with a fully filled-in config and a short, friendly plain-language summary of the " +
      "choices you made (leave question null). role_id always needs a real id from the list above, " +
      "never invent one.",
  },

  member_identity_setup: {
    maxQuestions: 4,
    buildResultSchema: () => turnSchema(memberIdentitySetupSchema()),
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up Member Identity: when a member leaves, " +
      "Dreamliner remembers their nickname, roles, and any active timeout, and can reapply them if " +
      "that member rejoins later, so they pick up where they left off instead of starting over " +
      `(restoring roles only ever adds roles back, it never removes anything). You are setting ` +
      `this up for the server "${ctx.guildName}". Ask ONE short, plain-language question at a ` +
      "time. Never mention field names, JSON, or config, ask like a helpful person would. Find " +
      "out: should their nickname come back, should their roles come back, and should an active " +
      "timeout come back too if they left while timed out (mention this needs Moderate Members and " +
      "is off by default since it's a stricter choice). Only ask about a delay before restoring " +
      "(e.g. to let autorole or a verification step run first) if it feels relevant, otherwise " +
      "leave delay_seconds at 0. skip_managed_roles should stay true unless the user specifically " +
      "wants bot/booster/integration roles restored too. " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\n" +
      progressInstruction(questionsAsked, 4) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action " +
      "\"ready\" with a fully filled-in config and a short, friendly plain-language summary of the " +
      "choices you made (leave question null).",
  },

  role_panel_setup: {
    maxQuestions: 6,
    requiresEntity: {
      kind: "textChannels",
      message: "This server has no text channels yet. Create one first, then try Autopilot setup again.",
    },
    buildResultSchema: (ctx) => turnSchema(rolePanelSetupSchema(ctx)),
    validateConfig: (config, ctx) => {
      const channelId = config.channel_id;
      if (typeof channelId !== "string" || !ctx.textChannels.some((c) => c.id === channelId)) {
        return "Autopilot picked a channel that doesn't exist. Please try again.";
      }
      const roles = config.roles;
      if (!Array.isArray(roles) || roles.length === 0) {
        return "Autopilot didn't pick any roles for the panel. Please try again.";
      }
      const isReaction = config.trigger_type === "reaction";
      if (roles.length > 25 || (isReaction && roles.length > 20)) {
        return "Autopilot picked too many roles for one panel. Please try again with fewer.";
      }
      for (const entry of roles) {
        if (!entry || typeof entry !== "object") {
          return "Autopilot's setup was inconsistent. Please try again.";
        }
        const role = entry as Record<string, unknown>;
        if (typeof role.role_id !== "string" || !ctx.roles.some((r) => r.id === role.role_id)) {
          return "Autopilot picked a role that doesn't exist. Please try again.";
        }
        if (isReaction && (typeof role.emoji !== "string" || !role.emoji.trim())) {
          return "Autopilot's setup was inconsistent (reaction panels need an emoji for every role). Please try again.";
        }
        if (typeof role.emoji === "string" && role.emoji.trim()) {
          role.emoji = resolveEmojiByName(role.emoji, ctx.emojis);
        }
      }
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up a Role Panel: a message with either emoji " +
      "reactions or buttons that members click to give themselves a role, like a self-serve " +
      `"roles" channel. You are setting this up for the server "${ctx.guildName}". Ask ONE short, ` +
      "plain-language question at a time. Never mention field names, JSON, or config, ask like a " +
      "helpful person would. Find out: which channel to post it in, whether members should react " +
      "with an emoji or click a button, whether they can pick more than one option or only one at " +
      "a time (picking a new one then removes their previous pick), a short intro message for the " +
      "panel, and which roles to offer, with a fitting emoji for each. Match every role the user " +
      "describes against the existing roles list below; never invent a role that isn't in it, and " +
      "ask for clarification if you can't find a good match. " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nExisting roles (pick role_id for each entry from these ids only; never pick a role that " +
      "sounds like a bot/managed role, e.g. named after a bot):\n" +
      `${entityList(ctx.roles)}\n\n` +
      "Existing text channels (pick channel_id from these ids only):\n" +
      `${entityList(ctx.textChannels)}\n\n` +
      "This server's custom emoji: " +
      `${emojiList(ctx.emojis)}. If the user means one of these (even just by name), put its exact ` +
      "name with no colons in that role's emoji and Dreamliner will use the real custom emoji. " +
      "Otherwise use a literal Unicode emoji matching the role. Reaction panels need a real emoji " +
      "for every role, never leave one empty; button panels can leave emoji empty if the user " +
      "doesn't want one there. label is only shown on buttons and can stay empty to just use the " +
      "role's own name. A panel can offer up to 25 roles (20 if using reactions).\n\n" +
      progressInstruction(questionsAsked, 6) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action " +
      "\"ready\" with a fully filled-in config and a short, friendly plain-language summary of the " +
      "choices you made (leave question null). roles always needs at least one real entry, never " +
      "leave it empty.",
  },

  booster_roles_setup: {
    maxQuestions: 4,
    buildResultSchema: (ctx) => turnSchema(boosterRoleTierSchema(ctx)),
    validateConfig: (config, ctx) => {
      const roleId = config.role_id;
      if (typeof roleId !== "string" || !roleId || !ctx.roles.some((r) => r.id === roleId)) {
        return "Autopilot didn't pick a real role for this tier. Please try again.";
      }
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up Booster Roles: as a member continuously boosts " +
      "the server for longer, Dreamliner automatically promotes them through role \"tiers\" you set " +
      "up (for example, a role at 30 days of boosting, a fancier one at 90 days). You are setting " +
      `this up for the server "${ctx.guildName}". Ask ONE short, plain-language question at a time. ` +
      "Never mention field names, JSON, or config, ask like a helpful person would. Find out: " +
      "should a member who reaches a higher tier keep every earlier tier's role too (stacking), or " +
      "only ever have their single highest tier's role at once, and then walk through one tier: " +
      "which role it grants, how many days of continuous boosting are needed first (0 means as soon " +
      "as they start boosting), and a short label for the dashboard. " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nExisting roles (pick role_id from these ids only; never pick a role that sounds like a " +
      "bot/managed role, e.g. named after a bot):\n" +
      `${entityList(ctx.roles)}\n\n` +
      progressInstruction(questionsAsked, 4) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action " +
      "\"ready\" with a fully filled-in config and a short, friendly plain-language summary of the " +
      "choices you made (leave question null). role_id always needs a real id from the list above, " +
      "never invent one.",
  },

  tags_setup: {
    maxQuestions: 3,
    buildResultSchema: () => turnSchema(tagSetupSchema()),
    validateConfig: (config) => {
      if (typeof config.name !== "string" || !config.name.trim()) {
        return "Autopilot didn't pick a name for the tag. Please try again.";
      }
      if (typeof config.content !== "string" || !config.content.trim()) {
        return "Autopilot didn't write anything for the tag to say. Please try again.";
      }
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up a Tag: a reusable snippet of text a moderator " +
      `can post with a slash command (e.g. /tag show rules). You are setting this up for the server ` +
      `"${ctx.guildName}". Ask ONE short, plain-language question at a time. Never mention field ` +
      "names, JSON, or config, ask like a helpful person would. Find out what the tag is for (e.g. " +
      "rules, an FAQ answer, a support pointer), a short name to call it by (one word, lowercase, no " +
      "spaces, e.g. \"rules\" or \"faq-payment\"), and what it should say. When you write the " +
      "content, make it warm and specific to what was asked, never generic filler. " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nAvailable placeholders in the content (use naturally, at most a couple): {user} " +
      "(mention), {username}, {guild} (server name), {memberCount}. Never invent other " +
      "placeholders.\n\n" +
      progressInstruction(questionsAsked, 3) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action " +
      "\"ready\" with a fully filled-in config and a short, friendly plain-language summary of the " +
      "choices you made (leave question null). name and content always need real values, never " +
      "leave either empty.",
  },

  giveaways_setup: {
    maxQuestions: 6,
    buildResultSchema: (ctx) => turnSchema(giveawaysSetupSchema(ctx)),
    validateConfig: (config, ctx) => {
      const logChannelId = config.log_channel_id;
      if (
        typeof logChannelId !== "string" ||
        (logChannelId && !ctx.textChannels.some((c) => c.id === logChannelId))
      ) {
        return "Autopilot picked a log channel that doesn't exist. Please try again.";
      }
      const pingRoleId = config.ping_role_id;
      if (typeof pingRoleId !== "string" || (pingRoleId && !ctx.roles.some((r) => r.id === pingRoleId))) {
        return "Autopilot picked a ping role that doesn't exist. Please try again.";
      }
      if (typeof config.default_reaction_emoji === "string" && config.default_reaction_emoji.trim()) {
        config.default_reaction_emoji = resolveEmojiByName(config.default_reaction_emoji, ctx.emojis);
      }
      if (typeof config.default_button_emoji === "string" && config.default_button_emoji.trim()) {
        config.default_button_emoji = resolveEmojiByName(config.default_button_emoji, ctx.emojis);
      }
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up Dreamliner's Giveaways defaults: the settings a " +
      "new giveaway is pre-filled with when staff create one from the dashboard (giveaways themselves " +
      "are created and run from the dashboard as separate entries, not by this wizard, you are only " +
      `choosing sensible starting defaults). You are setting this up for the server "${ctx.guildName}". ` +
      "Ask ONE short, plain-language question at a time. Never mention field names, JSON, or config, " +
      "ask like a helpful person would. Cover: how members should enter a giveaway by default " +
      "(clicking a button, with a label/emoji/color, or reacting with an emoji), how many winners a " +
      "giveaway usually has, whether winners and/or non-winners should get a DM when it ends, and " +
      "whether winners need to claim their prize within a time limit before an automatic reroll " +
      "happens. As one optional advanced question, ask whether server boosters should get extra " +
      "entry weight, whether entering or winning should cost or award server currency, and how a " +
      "required-role list should be matched (any of the roles, or all of them), the user can skip " +
      "this and keep the defaults. Finally ask which channel (if any) should log giveaway " +
      "start/end/reroll events, and which role (if any) should be pinged by default when a giveaway " +
      "starts. Don't interrogate on every option, use sensible defaults for anything not discussed " +
      "(default_entry_method button, default_button_label \"Enter\", default_button_style primary, " +
      "default_winner_count 1, default_dm_winner true, default_dm_non_winners false, " +
      "default_claim_window_minutes 0, default_require_role_mode any, default_booster_bonus_weight " +
      "0, default_entry_cost 0, default_win_bonus 0). " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nExisting text channels (pick log_channel_id from these ids only, or \"\" for no log):\n" +
      `${entityList(ctx.textChannels)}\n\n` +
      "Existing roles (pick ping_role_id from these ids only, or \"\" for no default ping):\n" +
      `${entityList(ctx.roles)}\n\n` +
      "This server's custom emoji: " +
      `${emojiList(ctx.emojis)}. If the user means one of these (even just by name), put its exact ` +
      "name with no colons in default_reaction_emoji or default_button_emoji and Dreamliner will use " +
      "the real custom emoji. Otherwise use a literal Unicode emoji, or keep a sensible default (a " +
      "gift emoji) if the user has no preference.\n\n" +
      "default_reaction_emoji is only used when default_entry_method is \"reaction\"; " +
      "default_button_label, default_button_emoji, and default_button_style are only used when it is " +
      "\"button\", but fill in all of them regardless. default_claim_window_minutes of 0 disables " +
      "the claim window. default_booster_bonus_weight, default_entry_cost, and default_win_bonus of " +
      "0 each disable that bonus/cost.\n\n" +
      progressInstruction(questionsAsked, 6) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action " +
      "\"ready\" with a fully filled-in config and a short, friendly plain-language summary of the " +
      "choices you made (leave question null).",
  },

  suggestions_setup: {
    maxQuestions: 5,
    requiresEntity: {
      kind: "textChannels",
      message: "This server has no text channels yet. Create one first, then try Autopilot setup again.",
    },
    buildResultSchema: (ctx) => turnSchema(suggestionsSetupSchema(ctx)),
    validateConfig: (config, ctx) => {
      const suggestionsChannelId = config.suggestions_channel_id;
      if (
        typeof suggestionsChannelId !== "string" ||
        !suggestionsChannelId ||
        !ctx.textChannels.some((c) => c.id === suggestionsChannelId)
      ) {
        return "Autopilot didn't pick a real suggestions channel. Please try again.";
      }
      const reviewChannelId = config.review_channel_id;
      if (
        typeof reviewChannelId !== "string" ||
        (reviewChannelId && !ctx.textChannels.some((c) => c.id === reviewChannelId))
      ) {
        return "Autopilot picked a review channel that doesn't exist. Please try again.";
      }
      if (config.mode === "review" && !reviewChannelId) {
        return "Autopilot set review mode but didn't pick a staff review channel. Please try again.";
      }
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up Dreamliner's Suggestions feature: members submit " +
      "ideas with /suggest, which either go straight to a public feed or through a staff review queue " +
      `first. You are setting this up for the server "${ctx.guildName}". Ask ONE short, plain-language ` +
      "question at a time. Never mention field names, JSON, or config, ask like a helpful person " +
      "would. First find out whether suggestions should be reviewed by staff before they go public " +
      "(review mode) or post straight to the public feed (autoapprove mode), and which channel the " +
      "public feed should be in, this is required. Only if they pick review mode, also ask which " +
      "channel staff should use to review incoming suggestions. Then ask about any submission limits " +
      "worth setting (how long a member must wait between suggestions, how many of the server's " +
      "messages they need to have sent first, and how old their Discord account needs to be), and " +
      "whether suggestions should be anonymous, allow voting, and allow image attachments. Don't " +
      "interrogate on every option, use sensible defaults for anything not discussed (anonymous " +
      "false, cooldown \"1h\", min_messages 25, min_account_age \"7d\", voting_enabled true, " +
      "allow_attachments true). " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nExisting text channels (pick suggestions_channel_id and review_channel_id from these ids " +
      "only; review_channel_id can be \"\" when mode is autoapprove):\n" +
      `${entityList(ctx.textChannels)}\n\n` +
      "cooldown and min_account_age are short durations like \"1h\", \"30m\", \"7d\", or an empty " +
      "string to disable that limit entirely.\n\n" +
      progressInstruction(questionsAsked, 5) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action " +
      "\"ready\" with a fully filled-in config and a short, friendly plain-language summary of the " +
      "choices you made (leave question null). suggestions_channel_id always needs a real id from " +
      "the list above, never invent one, and review_channel_id must be a real id too whenever mode " +
      "is review.",
  },

  tickets_setup: {
    maxQuestions: 7,
    requiresEntity: {
      kind: "textChannels",
      message: "This server has no text channels yet. Create one first, then try Autopilot setup again.",
    },
    buildResultSchema: (ctx) => turnSchema(ticketsSetupSchema(ctx)),
    validateConfig: (config, ctx) => {
      const panelChannelId = config.panel_channel_id;
      if (
        typeof panelChannelId !== "string" ||
        !panelChannelId ||
        !ctx.textChannels.some((c) => c.id === panelChannelId)
      ) {
        return "Autopilot didn't pick a real channel for the ticket panel. Please try again.";
      }
      const logChannelId = config.log_channel_id;
      if (
        typeof logChannelId !== "string" ||
        (logChannelId && !ctx.textChannels.some((c) => c.id === logChannelId))
      ) {
        return "Autopilot picked a log channel that doesn't exist. Please try again.";
      }
      const transcriptChannelId = config.default_transcript_channel_id;
      if (
        typeof transcriptChannelId !== "string" ||
        (transcriptChannelId && !ctx.textChannels.some((c) => c.id === transcriptChannelId))
      ) {
        return "Autopilot picked a transcript channel that doesn't exist. Please try again.";
      }
      const categoryChannelId = config.category_channel_id;
      if (
        typeof categoryChannelId !== "string" ||
        (categoryChannelId && !ctx.categories.some((c) => c.id === categoryChannelId))
      ) {
        return "Autopilot picked a Discord category that doesn't exist. Please try again.";
      }
      const staffRoleIds = config.staff_role_ids;
      if (!Array.isArray(staffRoleIds)) {
        return "Autopilot's setup was inconsistent. Please try again.";
      }
      config.staff_role_ids = staffRoleIds.filter(
        (id) => typeof id === "string" && ctx.roles.some((r) => r.id === id),
      );
      const supportRoleIds = config.category_support_role_ids;
      if (!Array.isArray(supportRoleIds)) {
        return "Autopilot's setup was inconsistent. Please try again.";
      }
      config.category_support_role_ids = supportRoleIds.filter(
        (id) => typeof id === "string" && ctx.roles.some((r) => r.id === id),
      );
      if (typeof config.category_emoji === "string" && config.category_emoji.trim()) {
        config.category_emoji = resolveEmojiByName(config.category_emoji, ctx.emojis);
      }
      return null;
    },
    buildSystemPrompt: (ctx, questionsAsked) =>
      "You are helping a Discord server admin set up Dreamliner's Tickets feature: members open a " +
      "private support ticket by clicking a panel in a channel, staff handle it, and it closes with " +
      "an optional transcript. This wizard sets up the plugin-wide basics plus exactly one panel with " +
      "one ticket category, enough to get a working support flow live today, more panels and " +
      "categories, custom intake questions, and escalation rules can all be added afterward from the " +
      `dashboard's own editor. You are setting this up for the server "${ctx.guildName}". Ask ONE ` +
      "short, plain-language question at a time. Never mention field names, JSON, or config, ask " +
      "like a helpful person would. Cover, roughly in this order: which role(s) should be able to " +
      "see and manage tickets as staff, and which channel (if any) should log ticket " +
      "open/claim/close events; which channel the ticket panel message should be posted in, and " +
      "whether members pick a category with buttons or a dropdown select menu (only one category " +
      "exists today so either works, buttons are simpler); the panel's embed title and description, " +
      "written specifically for this server, explaining how to open a ticket, plus any short text " +
      "above the embed if they want one; a short label shown on the category's button or option, a " +
      "fitting emoji, and a button color; which Discord channel category (the folder tickets get " +
      "created under) new ticket channels should live in, if any, whether a ticket should be its own " +
      "channel or a private thread, and a naming pattern (default \"ticket-{number}\"); the message " +
      "posted inside a new ticket welcoming the member, written specifically for this server's " +
      "support context; and finally, which roles (if any, beyond the staff roles already chosen) " +
      "should specifically handle this category, which channel transcripts should post to by " +
      "default, and whether the opener should get their transcript by DM when the ticket closes. " +
      "Don't interrogate on every option, use sensible defaults for anything not discussed " +
      "(panel_style buttons, category_button_style primary, category_mode channel, " +
      "category_naming_pattern \"ticket-{number}\", dm_transcript_on_close true, empty arrays or " +
      "strings for anything left unaddressed). " +
      NEVER_EM_DASH_RULE +
      " " +
      ANSWER_KIND_RULE +
      "\n\nExisting roles (pick staff_role_ids and category_support_role_ids from these ids only, " +
      "both can be left empty, category_support_role_ids falls back to staff_role_ids when empty so " +
      "it's fine to leave it empty if staff_role_ids already covers this category):\n" +
      `${entityList(ctx.roles)}\n\n` +
      "Existing text channels (pick panel_channel_id, log_channel_id, and " +
      "default_transcript_channel_id from these ids only; panel_channel_id is required, the others " +
      "can be \"\"):\n" +
      `${entityList(ctx.textChannels)}\n\n` +
      "Existing Discord categories/folders (pick category_channel_id from these ids only, or \"\" " +
      "for tickets to be created without a parent category):\n" +
      `${entityList(ctx.categories)}\n\n` +
      "This server's custom emoji: " +
      `${emojiList(ctx.emojis)}. If the user means one of these (even just by name), put its exact ` +
      "name with no colons in category_emoji and Dreamliner will use the real custom emoji. " +
      "Otherwise use a literal Unicode emoji, or leave category_emoji empty if they don't want one.\n\n" +
      "category_description is only shown on select-style panels and can be left empty. " +
      "category_naming_pattern supports {number}, {username}, and {category} placeholders. " +
      "category_welcome_message supports {user}, {guild}, and {category} placeholders and should " +
      "actually welcome the member and set expectations, never generic filler.\n\n" +
      progressInstruction(questionsAsked, 7) +
      "Respond with action \"ask\" and a question (leave summary and config null), or action " +
      "\"ready\" with a fully filled-in config and a short, friendly plain-language summary of the " +
      "choices you made (leave question null). panel_channel_id always needs a real id from the " +
      "text channel list above, never invent one.",
  },
};

export function isKnownAiWizard(wizard: string): wizard is keyof typeof AI_WIZARDS {
  return Object.prototype.hasOwnProperty.call(AI_WIZARDS, wizard);
}
