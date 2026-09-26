/**
 * Tickets Autopilot wizard: adds one new ticket panel per run (with one or more categories) and
 * can adjust the plugin-wide settings. Covers every user-facing field of zTicketsConfig,
 * zTicketPanel, zTicketCategory, zTicketFormQuestion and zTicketEscalationStep. Plugin-wide fields
 * are nullable so staff roles, log channels and toggles nobody mentioned are left alone.
 */
import {
  MAX_FORM_QUESTIONS,
  TICKET_BUTTON_STYLES,
  TICKET_CLOSE_PERMISSIONS,
  TICKET_CONTAINER_MODES,
  TICKET_ESCALATION_ACTIONS,
  TICKET_PANEL_STYLES,
  TICKET_PRIORITIES,
  TICKET_QUESTION_TYPES,
} from "../../../config/schemas/tickets.js";
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
  num,
  obj,
  oneOf,
  persistEmbedSchema,
  progressInstruction,
  str,
  turnSchemaWithIds,
  validId,
  type AiWizardContext,
  type AiWizardDefinition,
} from "../wizardKit.js";
import { boolOrNull, isRow, sanitizePersistEmbed, strOrNull } from "./autoRuleKit.js";

type Row = Record<string, unknown>;

const MAX_QUESTIONS = 8;
/** Categories one wizard run may add to its panel (the schema allows 25 on select panels). */
export const MAX_WIZARD_CATEGORIES = 10;
const MAX_ESCALATION_STEPS = 10;
const OPTION_QUESTION_TYPES = ["string_select", "radio_group", "checkbox_group"];
const COUNTED_QUESTION_TYPES = [
  "string_select",
  "user_select",
  "role_select",
  "mentionable_select",
  "channel_select",
  "checkbox_group",
  "file_upload",
];

function questionSchema(): Record<string, unknown> {
  return obj({
    label: str(),
    type: oneOf(TICKET_QUESTION_TYPES),
    style: nullable(oneOf(["short", "paragraph"])),
    required: nullable(bool()),
    placeholder: nullable(str()),
    max_length: nullable(int()),
    content: nullable(str()),
    options: nullable({
      type: "array",
      items: obj({ label: str(), value: str(), description: nullable(str()) }),
    }),
    min_values: nullable(int()),
    max_values: nullable(int()),
  });
}

function escalationStepSchema(): Record<string, unknown> {
  return obj({
    after_minutes: int(),
    action: oneOf(TICKET_ESCALATION_ACTIONS),
    role_id: idOrEmpty("role"),
    channel_id: idOrEmpty("text_channel"),
    priority: nullable(oneOf(TICKET_PRIORITIES)),
    message: nullable(str()),
  });
}

function categorySchema(): Record<string, unknown> {
  return obj({
    label: str(),
    description: nullable(str()),
    emoji: nullable(str()),
    button_style: nullable(oneOf(TICKET_BUTTON_STYLES)),
    category_channel_id: idRef("category"),
    mode: nullable(oneOf(TICKET_CONTAINER_MODES)),
    naming_pattern: nullable(str()),
    welcome_message: nullable(str()),
    support_role_ids: nullable(idArray("role")),
    ping_role_ids: nullable(idArray("role")),
    form_questions: nullable({ type: "array", items: questionSchema() }),
    max_open_per_user: nullable(int()),
    auto_close_hours: nullable(num()),
    escalation: nullable({ type: "array", items: escalationStepSchema() }),
    close_permission: nullable(oneOf(TICKET_CLOSE_PERMISSIONS)),
    require_close_reason: nullable(bool()),
    transcript_channel_id: nullable(idOrEmpty("text_channel")),
    feedback_enabled: nullable(bool()),
  });
}

export function ticketsConfigSchema(): Record<string, unknown> {
  return obj({
    staff_role_ids: nullable(idArray("role")),
    log_channel_id: nullable(idOrEmpty("text_channel")),
    default_transcript_channel_id: nullable(idOrEmpty("text_channel")),
    dm_transcript_on_close: nullable(bool()),
    feedback_enabled: nullable(bool()),
    max_open_tickets_per_user: nullable(int()),
    blacklist_notify: nullable(bool()),
    sync_status_to_topic: nullable(bool()),
    auto_status_updates: nullable(bool()),
    panel: obj({
      name: nullable(str()),
      enabled: nullable(bool()),
      channel_id: idRef("text_channel"),
      style: nullable(oneOf(TICKET_PANEL_STYLES)),
      content: nullable(str()),
      embed: nullable(persistEmbedSchema()),
      categories: { type: "array", items: categorySchema() },
    }),
  });
}

function enumOrNull<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/** An optional id: null stays null ("unchanged"), "" means none, unknown ids become null. */
function optionalId(value: unknown, ctx: AiWizardContext, kind: "text_channel" | "role"): string | null {
  if (typeof value !== "string") return null;
  return validId(value, ctx, kind) ? value : null;
}

function sanitizeQuestion(q: Row): Row | null {
  const label = typeof q.label === "string" ? q.label.trim().slice(0, 45) : "";
  const type = enumOrNull(q.type, TICKET_QUESTION_TYPES) ?? "text";
  if (!label) return null;
  const out: Row = {
    label,
    type,
    style: type === "text" ? enumOrNull(q.style, ["short", "paragraph"] as const) : null,
    required: type === "checkbox" || type === "text_display" ? null : boolOrNull(q.required),
    placeholder: type === "text" ? strOrNull(q.placeholder, 100) : null,
    max_length: type === "text" ? clampInt(q.max_length, 1, 4000) : null,
    content: null,
    options: null,
    min_values: null,
    max_values: null,
  };
  if (type === "text_display") {
    const content = typeof q.content === "string" ? q.content.trim().slice(0, 4000) : "";
    if (!content) return null;
    out.content = content;
  }
  if (OPTION_QUESTION_TYPES.includes(type)) {
    const options = (Array.isArray(q.options) ? q.options.filter(isRow) : [])
      .map((o) => {
        const optLabel = typeof o.label === "string" ? o.label.trim().slice(0, 100) : "";
        const value = (typeof o.value === "string" ? o.value.trim().slice(0, 100) : "") || optLabel;
        const description = typeof o.description === "string" ? o.description.trim().slice(0, 100) : "";
        return { label: optLabel, value, description: description || null };
      })
      .filter((o) => o.label)
      .slice(0, 25);
    if (options.length === 0) return null;
    out.options = options;
  }
  if (COUNTED_QUESTION_TYPES.includes(type)) {
    let min = clampInt(q.min_values, 0, 25);
    const max = clampInt(q.max_values, 1, 25);
    if (min !== null && max !== null && min > max) min = max;
    out.min_values = min;
    out.max_values = max;
  }
  return out;
}

function sanitizeEscalationStep(step: Row, ctx: AiWizardContext): Row | null {
  const action = enumOrNull(step.action, TICKET_ESCALATION_ACTIONS);
  const afterMinutes = clampInt(step.after_minutes, 1, 100_000);
  if (!action || afterMinutes === null) return null;
  const roleId = typeof step.role_id === "string" && validId(step.role_id, ctx, "role") ? step.role_id : "";
  const channelId =
    typeof step.channel_id === "string" && validId(step.channel_id, ctx, "text_channel") ? step.channel_id : "";
  const priority = enumOrNull(step.priority, TICKET_PRIORITIES);
  if (action === "ping_role" && !roleId) return null;
  if (action === "notify_channel" && !channelId) return null;
  if (action === "set_priority" && !priority) return null;
  return {
    after_minutes: afterMinutes,
    action,
    role_id: action === "ping_role" ? roleId : "",
    channel_id: action === "notify_channel" ? channelId : "",
    priority: action === "set_priority" ? priority : null,
    message: typeof step.message === "string" ? step.message.trim().slice(0, 500) : "",
  };
}

function sanitizeCategory(c: Row, ctx: AiWizardContext): Row | string {
  const label = typeof c.label === "string" ? c.label.trim().slice(0, 80) : "";
  if (!label) return "a category without a label";
  const categoryId = c.category_channel_id;
  if (typeof categoryId !== "string" || !categoryId || !validId(categoryId, ctx, "category")) {
    return "a category without a real Discord category to create tickets under";
  }
  return {
    label,
    description: strOrNull(c.description, 100),
    emoji: typeof c.emoji === "string" ? resolveEmojiByName(c.emoji, ctx.emojis).slice(0, 128) : null,
    button_style: enumOrNull(c.button_style, TICKET_BUTTON_STYLES),
    category_channel_id: categoryId,
    mode: enumOrNull(c.mode, TICKET_CONTAINER_MODES),
    naming_pattern: typeof c.naming_pattern === "string" && c.naming_pattern.trim() ? c.naming_pattern.trim().slice(0, 80) : null,
    welcome_message:
      typeof c.welcome_message === "string" && c.welcome_message.trim() ? c.welcome_message.slice(0, 2000) : null,
    support_role_ids: keepIds(c.support_role_ids, ctx, "role"),
    ping_role_ids: keepIds(c.ping_role_ids, ctx, "role"),
    form_questions: Array.isArray(c.form_questions)
      ? c.form_questions
          .filter(isRow)
          .map(sanitizeQuestion)
          .filter((q): q is Row => q !== null)
          .slice(0, MAX_FORM_QUESTIONS)
      : null,
    max_open_per_user: clampInt(c.max_open_per_user, 0, 100_000),
    auto_close_hours:
      typeof c.auto_close_hours === "number" && Number.isFinite(c.auto_close_hours)
        ? Math.min(100_000, Math.max(0, c.auto_close_hours))
        : null,
    escalation: Array.isArray(c.escalation)
      ? c.escalation
          .filter(isRow)
          .map((s) => sanitizeEscalationStep(s, ctx))
          .filter((s): s is Row => s !== null)
          .sort((a, b) => (a.after_minutes as number) - (b.after_minutes as number))
          .slice(0, MAX_ESCALATION_STEPS)
      : null,
    close_permission: enumOrNull(c.close_permission, TICKET_CLOSE_PERMISSIONS),
    require_close_reason: boolOrNull(c.require_close_reason),
    transcript_channel_id: optionalId(c.transcript_channel_id, ctx, "text_channel"),
    feedback_enabled: boolOrNull(c.feedback_enabled),
  };
}

export const validateTicketsConfig: NonNullable<AiWizardDefinition["validateConfig"]> = (config, ctx) => {
  if (!isRow(config.panel)) return "Autopilot's setup was inconsistent. Please try again.";
  const panel = config.panel;
  const channelId = panel.channel_id;
  if (typeof channelId !== "string" || !channelId || !validId(channelId, ctx, "text_channel")) {
    return "Autopilot didn't pick a real channel for the ticket panel. Please try again.";
  }
  if (ctx.categories.length === 0) {
    return "Tickets need a Discord category (a channel folder) to create ticket channels under, and this server has none yet. Create one, then try again.";
  }

  const categories: Row[] = [];
  let problem: string | null = null;
  for (const raw of (Array.isArray(panel.categories) ? panel.categories.filter(isRow) : []).slice(0, MAX_WIZARD_CATEGORIES)) {
    const result = sanitizeCategory(raw, ctx);
    if (typeof result === "string") problem ??= result;
    else categories.push(result);
  }
  if (categories.length === 0) {
    return `Autopilot didn't produce a usable ticket category${problem ? ` (${problem})` : ""}. Please try again.`;
  }
  panel.categories = categories;
  panel.name = strOrNull(panel.name, 80);
  panel.enabled = boolOrNull(panel.enabled);
  panel.style = enumOrNull(panel.style, TICKET_PANEL_STYLES);
  // Button panels hold at most 5 categories; more than that only fits a select menu.
  if (categories.length > 5) panel.style = "select";
  panel.content = typeof panel.content === "string" ? panel.content.slice(0, 2000) : null;
  panel.embed = sanitizePersistEmbed(panel.embed);

  config.staff_role_ids = keepIds(config.staff_role_ids, ctx, "role");
  config.log_channel_id = optionalId(config.log_channel_id, ctx, "text_channel");
  config.default_transcript_channel_id = optionalId(config.default_transcript_channel_id, ctx, "text_channel");
  for (const key of ["dm_transcript_on_close", "feedback_enabled", "blacklist_notify", "sync_status_to_topic", "auto_status_updates"]) {
    config[key] = boolOrNull(config[key]);
  }
  config.max_open_tickets_per_user = clampInt(config.max_open_tickets_per_user, 1, 100_000);
  return null;
};

export const ticketsWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 4000,
  requiresEntity: {
    kind: "textChannels",
    message: "This server has no text channels yet. Create one first, then try Autopilot setup again.",
  },
  buildResultSchema: (ctx) => turnSchemaWithIds(ticketsConfigSchema(), ctx),
  validateConfig: validateTicketsConfig,
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up Dreamliner's Tickets feature: members open a " +
    "private support ticket from a panel message, staff handle it, and it closes with an optional " +
    "transcript. Each run adds one new ticket panel (with one or more ticket categories) and can " +
    `also change the plugin-wide settings. You are setting this up for the server "${ctx.guildName}". ` +
    "Ask ONE short, plain-language question at a time. Never mention field names, JSON, or config, " +
    "ask like a helpful person would.\n\n" +
    "Plugin-wide settings (top level, all nullable): staff_role_ids (roles that see and manage every " +
    "ticket), log_channel_id (ticket open/claim/close log, \"\" for none), " +
    "default_transcript_channel_id (where transcripts post, \"\" for none), dm_transcript_on_close " +
    "(DM the opener their transcript, default on), feedback_enabled (DM the opener a rating request " +
    "after close, default off), max_open_tickets_per_user (default 1), blacklist_notify (tell " +
    "blacklisted members why they were blocked, default on), sync_status_to_topic (show a ticket's " +
    "status in the channel topic or thread name, default off), auto_status_updates (set Awaiting " +
    "Response when staff reply and In Progress when the member replies, default off).\n" +
    "The panel: channel_id is where the panel message is posted (required). style is \"buttons\" (one " +
    "button per category, max 5) or \"select\" (a dropdown, up to 25). content is optional text " +
    "above the embed, and embed is the panel's full embed (title, description, color, author, " +
    "thumbnail, image, footer, timestamp, up to 25 fields; icon and thumbnail sources are none, " +
    "guild, bot, or url). The embed supports {guild}, {avg_response_time} and {avg_resolution_time}. " +
    "name is a dashboard-only label, enabled turns the panel on or off.\n" +
    "Each category: label (button or option text, max 80), description (select panels only, max " +
    "100), emoji, button_style (primary blurple, secondary gray, success green, danger red), " +
    "category_channel_id (the Discord category, a channel folder, new tickets are created under; " +
    "always required), mode (\"channel\" for a private channel or \"thread\" for a private thread), " +
    "naming_pattern (default \"ticket-{number}\", supports {number}, {username}, {category}), " +
    "welcome_message (posted in the new ticket, supports {user}, {guild}, {category} and {answer_1}, " +
    "{answer_2}... for form answers; make it actually welcome the member and set expectations), " +
    "support_role_ids (roles for this category, falls back to staff_role_ids when empty), " +
    "ping_role_ids (roles pinged when a ticket opens), form_questions (up to 5 questions asked in a " +
    "pop-up before the ticket opens), max_open_per_user (per-category limit, 0 blocks new tickets), " +
    "auto_close_hours (close after this many hours without a reply from the opener, 0 off), " +
    "escalation (up to 10 steps fired after minutes without a staff reply), close_permission " +
    "(\"opener\", \"staff\", or \"either\"), require_close_reason, transcript_channel_id (per-category " +
    "transcript channel, \"\" to use the plugin-wide one), feedback_enabled (per-category override).\n" +
    "A form question has label (max 45) and type: text (style short or paragraph, placeholder, " +
    "max_length up to 4000), string_select, radio_group or checkbox_group (options with label, value, " +
    "optional description, up to 25), user_select, role_select, mentionable_select, channel_select, " +
    "file_upload (min_values/max_values up to 25), checkbox (one yes/no box), or text_display " +
    "(content shown as information, no answer). required says whether it must be answered.\n" +
    "An escalation step has after_minutes and action: ping_role (needs role_id), notify_channel " +
    "(needs channel_id), set_priority (needs priority: low, medium, high, urgent), or close; message " +
    "is an optional note. Use \"\" for role_id or channel_id when the action doesn't need it.\n" +
    COLOR_RULE +
    "\n\nCover the essentials in a few questions: staff roles, where the panel goes, which kinds of " +
    "tickets to offer, and which Discord category tickets are created in (if you can't tell which " +
    "category from the list below, ask; never guess an unrelated one). Write the panel embed " +
    "specifically for this server. Plugin-wide settings the user didn't bring up must be null, " +
    "even when you would pick the default; \"\" removes a current log or transcript channel, so only " +
    "use it when the user asks for none. " +
    NULL_MEANS_UNCHANGED_RULE +
    " " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nExisting roles (pick every role id from these ids only):\n" +
    `${entityList(ctx.roles)}\n\n` +
    "Existing text channels (pick every channel id from these ids only):\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    "Existing Discord categories (pick category_channel_id from these ids only):\n" +
    `${entityList(ctx.categories)}\n` +
    (ctx.categories.length === 0
      ? "This server has no categories yet, so tickets can't be created. Tell the user to create a " +
        "category (a channel folder) in Discord first, then run this setup again.\n"
      : "") +
    "\n" +
    `This server's custom emoji: ${emojiList(ctx.emojis)}. If the user means one of these (even just ` +
    "by name), put its exact name with no colons in a category's emoji and Dreamliner will use the " +
    "real custom emoji. Otherwise use a literal Unicode emoji, or null for none.\n\n" +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action \"ready\" " +
    "with the config and a short, friendly plain-language summary of the choices you made (leave " +
    "question null). The panel always needs a real channel_id and at least one category, and every " +
    "category needs a label and a real category_channel_id.",
};
