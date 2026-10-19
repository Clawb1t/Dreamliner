/**
 * Autopilot wizard for Appeals (punishment appeals from the website). Covers everything the setup
 * page does: the public appeal page, which punishments can be appealed (wait, window, lift on
 * approve), manual appeals, the appeal forms and their questions, limits, the review channel,
 * decision DMs and the Appeal button on punishment DMs.
 *
 * Wizards don't see the current config, so forms are all-or-nothing: when the model returns
 * `forms` it replaces the server's forms, and each type (and manual appeals) points at one by
 * `form_index` (0 = the first, which is also the default). Blocked users and uploaded backgrounds
 * stay dashboard-only. Every setting is nullable: null means "leave it as it is".
 */
import { APPEAL_QUESTION_TYPES, APPEALABLE_TYPES, MAX_APPEAL_CUSTOM_OPTIONS, MAX_APPEAL_FORMS, MAX_APPEAL_QUESTIONS } from "../../../config/schemas/appeals.js";
import {
  ANSWER_KIND_RULE,
  COLOR_RULE,
  NEVER_EM_DASH_RULE,
  NULL_MEANS_UNCHANGED_RULE,
  bool,
  clampInt,
  entityList,
  idArray,
  idOrEmpty,
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
} from "../wizardKit.js";
import { boolOrNull, enumOrNull, isRec, text } from "./welcome.js";

type Rec = Record<string, unknown>;

const MAX_QUESTIONS = 7;
const DURATION_RE = /^\d+[smhdw]$/;
const PAGE_BACKGROUNDS = ["none", "color", "url", "guild_banner"] as const;
const OPTION_TYPES = ["string_select", "radio_group", "checkbox_group"];

const PAGE_TEXT_FIELDS: Record<string, number> = {
  headline: 200,
  body: 2000,
  guidelines: 4000,
  login_button_label: 80,
  submitted_title: 200,
  submitted_body: 2000,
  closed_title: 200,
  closed_body: 2000,
};
const PAGE_BOOL_FIELDS = ["inherit_accent", "show_server_icon", "show_moderator", "show_case_reason", "link_on_server_page"] as const;
/** Labels that can't be blank: an empty string means "unchanged". */
const NON_BLANK = new Set(["headline", "login_button_label", "submitted_title", "closed_title"]);

function questionSchema(): Rec {
  return obj({
    label: str(),
    type: oneOf(APPEAL_QUESTION_TYPES),
    style: nullable(oneOf(["short", "paragraph"])),
    required: nullable(bool()),
    placeholder: nullable(str()),
    min_length: nullable(int()),
    max_length: nullable(int()),
    content: nullable(str()),
    options: nullable({ type: "array", items: obj({ label: str(), value: str(), description: nullable(str()) }) }),
    min_values: nullable(int()),
    max_values: nullable(int()),
  });
}

function typeRuleSchema(): Rec {
  return nullable(
    obj({
      enabled: nullable(bool()),
      form_index: nullable(int()),
      min_wait: nullable(str()),
      window: nullable(str()),
      allow_inactive: nullable(bool()),
      auto_reverse: nullable(bool()),
    }),
  );
}

export function appealsConfigSchema(): Rec {
  const page: Record<string, Rec> = {};
  for (const key of Object.keys(PAGE_TEXT_FIELDS)) page[key] = nullable(str());
  for (const key of PAGE_BOOL_FIELDS) page[key] = nullable(bool());
  page.accent_color = nullable(int());
  page.background = nullable(oneOf(PAGE_BACKGROUNDS));
  page.background_color = nullable(int());
  page.background_url = nullable(str());

  const types: Record<string, Rec> = {};
  for (const type of APPEALABLE_TYPES) types[type] = typeRuleSchema();

  return obj({
    accepting: nullable(bool()),
    page: nullable(obj(page)),
    types: nullable(obj(types)),
    manual: nullable(
      obj({
        enabled: nullable(bool()),
        form_index: nullable(int()),
        label: nullable(str()),
        description: nullable(str()),
        require_ban: nullable(bool()),
      }),
    ),
    custom_options: nullable({
      type: "array",
      items: obj({
        label: str(),
        description: nullable(str()),
        form_index: nullable(int()),
        require_ban: nullable(bool()),
        lift_discord_ban: nullable(bool()),
      }),
    }),
    forms: nullable({
      type: "array",
      items: obj({ name: str(), intro: nullable(str()), questions: { type: "array", items: questionSchema() } }),
    }),
    limits: nullable(
      obj({
        max_per_case: nullable(int()),
        deny_cooldown: nullable(str()),
        max_open_per_user: nullable(int()),
        min_account_age: nullable(str()),
        blocked_roles: nullable(idArray("role")),
      }),
    ),
    review: nullable(
      obj({
        channel_id: nullable(idOrEmpty("text_channel")),
        ping_roles: nullable(idArray("role")),
        thread: nullable(bool()),
        require_deny_reason: nullable(bool()),
        show_history: nullable(bool()),
      }),
    ),
    decisions: nullable(
      obj({
        dm_user: nullable(bool()),
        approve_message: nullable(str()),
        deny_message: nullable(str()),
        needs_info_message: nullable(str()),
        invite_on_unban: nullable(bool()),
        invite_channel_id: nullable(idOrEmpty("text_channel")),
      }),
    ),
    dm_button: nullable(obj({ enabled: nullable(bool()), label: nullable(str()) })),
  });
}

/** "24h", "7d", or "" for none; anything else is "unchanged". */
function duration(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase().replace(/\s+/g, "");
  return trimmed === "" || DURATION_RE.test(trimmed) ? trimmed : null;
}

function label(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

export function sanitizeAppealQuestion(q: Rec): Rec | null {
  const type = enumOrNull(q.type, APPEAL_QUESTION_TYPES) ?? "text";
  const questionLabel = typeof q.label === "string" ? q.label.trim().slice(0, 45) : "";
  if (type !== "text_display" && !questionLabel) return null;
  const out: Rec = {
    label: questionLabel,
    type,
    style: type === "text" ? (enumOrNull(q.style, ["short", "paragraph"]) ?? "paragraph") : null,
    required: type === "text_display" ? null : boolOrNull(q.required),
    placeholder: type === "text" ? (text(q.placeholder, 100) ?? null) : null,
    min_length: null,
    max_length: null,
    content: null,
    options: null,
    min_values: null,
    max_values: null,
  };
  if (type === "text") {
    const max = clampInt(q.max_length, 1, 4000);
    let min = clampInt(q.min_length, 0, 4000);
    if (min !== null && min > (max ?? 1000)) min = max ?? 1000;
    out.max_length = max;
    out.min_length = min;
  }
  if (type === "text_display") {
    const content = typeof q.content === "string" ? q.content.trim().slice(0, 4000) : "";
    if (!content) return null;
    out.content = content;
  }
  if (OPTION_TYPES.includes(type)) {
    const options = (Array.isArray(q.options) ? q.options.filter(isRec) : [])
      .map((o) => {
        const optLabel = typeof o.label === "string" ? o.label.trim().slice(0, 100) : "";
        const value = (typeof o.value === "string" ? o.value.trim().slice(0, 100) : "") || optLabel;
        const description = typeof o.description === "string" ? o.description.trim().slice(0, 100) : "";
        return { label: optLabel, value, description: description || null };
      })
      .filter((o) => o.label)
      .filter((o, i, all) => all.findIndex((other) => other.value === o.value) === i)
      .slice(0, 25);
    if (options.length === 0) return null;
    out.options = options;
  }
  if (type === "checkbox_group") {
    let min = clampInt(q.min_values, 0, 25);
    const max = clampInt(q.max_values, 1, 25);
    if (min !== null && max !== null && min > max) min = max;
    out.min_values = min;
    out.max_values = max;
  }
  return out;
}

function sanitizeForms(value: unknown): Rec[] | null {
  if (!Array.isArray(value)) return null;
  const forms = value
    .filter(isRec)
    .map((form) => {
      const questions = (Array.isArray(form.questions) ? form.questions.filter(isRec) : [])
        .map(sanitizeAppealQuestion)
        .filter((q): q is Rec => q !== null)
        .slice(0, MAX_APPEAL_QUESTIONS);
      return {
        name: label(form.name, 80) ?? "Appeal form",
        intro: text(form.intro, 2000) ?? "",
        questions,
      };
    })
    // A form that asks nothing gives staff nothing to go on.
    .filter((form) => form.questions.some((q) => q.type !== "text_display"))
    .slice(0, MAX_APPEAL_FORMS);
  return forms.length ? forms : null;
}

/** A form position that exists in the returned forms; anything else is "unchanged". */
function formIndex(value: unknown, forms: Rec[] | null): number | null {
  if (!forms) return null;
  const index = clampInt(value, 0, MAX_APPEAL_FORMS - 1);
  return index !== null && index < forms.length ? index : null;
}

export function validateAppealsConfig(config: Rec, ctx: AiWizardContext): string | null {
  config.accepting = boolOrNull(config.accepting);
  const forms = sanitizeForms(config.forms);
  config.forms = forms;

  if (isRec(config.review)) {
    const r = config.review;
    if (r.channel_id !== null && r.channel_id !== undefined && !validId(r.channel_id, ctx, "text_channel")) {
      return "Autopilot picked a review channel that doesn't exist. Please try again.";
    }
    r.channel_id = typeof r.channel_id === "string" ? r.channel_id : null;
    r.ping_roles = keepIds(r.ping_roles, ctx, "role");
    if (Array.isArray(r.ping_roles)) r.ping_roles = r.ping_roles.slice(0, 10);
    r.thread = boolOrNull(r.thread);
    r.require_deny_reason = boolOrNull(r.require_deny_reason);
    r.show_history = boolOrNull(r.show_history);
  } else {
    config.review = null;
  }

  if (isRec(config.page)) {
    const p = config.page;
    for (const [key, max] of Object.entries(PAGE_TEXT_FIELDS)) {
      p[key] = NON_BLANK.has(key) ? label(p[key], max) : text(p[key], max);
    }
    for (const key of PAGE_BOOL_FIELDS) p[key] = boolOrNull(p[key]);
    p.accent_color = clampInt(p.accent_color, 0, 0xffffff);
    p.background_color = clampInt(p.background_color, 0, 0xffffff);
    p.background = enumOrNull(p.background, PAGE_BACKGROUNDS);
    const url = typeof p.background_url === "string" ? p.background_url.trim() : null;
    // The page only shows https images; anything else would be rejected on save.
    p.background_url = url === null ? null : url === "" || /^https:\/\/\S+$/i.test(url) ? url.slice(0, 512) : null;
    if (p.background === "url" && !p.background_url) p.background = null;
  } else {
    config.page = null;
  }

  if (isRec(config.types)) {
    const types = config.types;
    for (const type of APPEALABLE_TYPES) {
      const rule = types[type];
      if (!isRec(rule)) {
        types[type] = null;
        continue;
      }
      rule.enabled = boolOrNull(rule.enabled);
      rule.form_index = formIndex(rule.form_index, forms);
      rule.min_wait = duration(rule.min_wait);
      rule.window = duration(rule.window);
      rule.allow_inactive = boolOrNull(rule.allow_inactive);
      rule.auto_reverse = boolOrNull(rule.auto_reverse);
    }
  } else {
    config.types = null;
  }

  if (isRec(config.manual)) {
    const m = config.manual;
    m.enabled = boolOrNull(m.enabled);
    m.form_index = formIndex(m.form_index, forms);
    m.label = label(m.label, 80);
    m.description = text(m.description, 300);
    m.require_ban = boolOrNull(m.require_ban);
  } else {
    config.manual = null;
  }

  if (Array.isArray(config.custom_options)) {
    config.custom_options = config.custom_options
      .filter(isRec)
      .map((option) => ({
        label: label(option.label, 80),
        description: text(option.description, 300),
        form_index: formIndex(option.form_index, forms),
        require_ban: boolOrNull(option.require_ban),
        lift_discord_ban: boolOrNull(option.lift_discord_ban),
      }))
      .filter((option) => option.label)
      .slice(0, MAX_APPEAL_CUSTOM_OPTIONS);
  } else {
    config.custom_options = null;
  }

  if (isRec(config.limits)) {
    const l = config.limits;
    l.max_per_case = clampInt(l.max_per_case, 1, 10);
    l.max_open_per_user = clampInt(l.max_open_per_user, 1, 10);
    l.deny_cooldown = duration(l.deny_cooldown);
    l.min_account_age = duration(l.min_account_age);
    l.blocked_roles = keepIds(l.blocked_roles, ctx, "role");
    if (Array.isArray(l.blocked_roles)) l.blocked_roles = l.blocked_roles.slice(0, 25);
  } else {
    config.limits = null;
  }

  if (isRec(config.decisions)) {
    const d = config.decisions;
    d.dm_user = boolOrNull(d.dm_user);
    d.approve_message = label(d.approve_message, 2000);
    d.deny_message = label(d.deny_message, 2000);
    d.needs_info_message = label(d.needs_info_message, 2000);
    d.invite_on_unban = boolOrNull(d.invite_on_unban);
    d.invite_channel_id =
      d.invite_channel_id === "" || validId(d.invite_channel_id, ctx, "text_channel") ? (d.invite_channel_id ?? null) : null;
  } else {
    config.decisions = null;
  }

  if (isRec(config.dm_button)) {
    config.dm_button.enabled = boolOrNull(config.dm_button.enabled);
    config.dm_button.label = label(config.dm_button.label, 80);
  } else {
    config.dm_button = null;
  }
  return null;
}

function buildAppealsPrompt(ctx: AiWizardContext, questionsAsked: number): string {
  return (
    "You are helping a Discord server admin set up Dreamliner's Appeals: people who were " +
    "punished (banned, kicked, muted or warned) sign in on a web page, pick a punishment on file " +
    "(or a manual appeal for one with no record), and fill in a form. The appeal is posted in a " +
    "staff review channel with Approve, Deny and Needs info buttons, and staff can also decide " +
    `on the dashboard. You are setting this up for the server "${ctx.guildName}". Ask ONE short, ` +
    "plain-language question at a time. Never mention field names, JSON, or config, ask like a " +
    "helpful person would.\n\n" +
    "What Appeals can do:\n" +
    "- accepting: whether new appeals are taken at all.\n" +
    "- Per punishment type (ban, tempban, softban, kick, mute, tempmute, warn): whether it can be " +
    "appealed, which form it uses (form_index, see forms), how long after the punishment before " +
    "it can be appealed (min_wait), how long it stays appealable (window), whether expired or " +
    "already lifted ones can still be appealed (allow_inactive), and whether approving lifts it " +
    "(auto_reverse: unban, remove the timeout, or revoke the case). Defaults: bans, tempbans, " +
    "mutes, tempmutes and warns on, kicks and softbans off, lift on approve on.\n" +
    "- Manual appeals for punishments with no case on file (a ban by hand or by another bot): " +
    "on/off, which form, the option's title and description, and whether only people who are " +
    "really banned can send one (require_ban, recommended on).\n" +
    `- custom_options: up to ${MAX_APPEAL_CUSTOM_OPTIONS} of the server's own appeal options, for ` +
    "punishments Dreamliner didn't give, e.g. a Minecraft server ban or a ban on another game " +
    "server. Each has a title (label), a description, a form (form_index), require_ban (only " +
    "people banned from this Discord server can pick it, usually off for other places) and " +
    "lift_discord_ban (approving also unbans them here, off for appeals about somewhere else). " +
    "Returning custom_options REPLACES the server's list, so return the full list, or null to " +
    "leave it alone.\n" +
    `- forms: up to ${MAX_APPEAL_FORMS} forms of up to ${MAX_APPEAL_QUESTIONS} questions, filled in on ` +
    "the website. Returning forms REPLACES the server's forms, so only return them when the user " +
    "wants questions changed or set up, and then return complete, well written forms. The first " +
    "form is the default. form_index on a type or manual appeals points at a position in the " +
    "forms you return (0 is the first); leave it null unless you return forms. Question types: " +
    "text (style short or paragraph, placeholder up to 100 characters, min_length and max_length " +
    "up to 4000, use min_length to stop one-word appeals), string_select and radio_group (pick one " +
    "option), checkbox_group (pick several, min_values and max_values), checkbox (a single box the " +
    "user must tick when required, good for 'I have read the rules'), and text_display (markdown " +
    "text shown to the user, no answer, use content). A question label is at most 45 characters. " +
    "Options have label, value and an optional description. A good appeal form asks what happened, " +
    "why the punishment should be lifted, and what they'll do differently: a full form usually has 3 " +
    "to 5 answerable questions (paragraph text with a sensible min_length for the main ones), plus " +
    "an agreement checkbox or a short text block when it helps. A shorter form for lighter " +
    "punishments can have 1 or 2.\n" +
    "- The public page: headline and body (support {guild}), guidelines (markdown shown above " +
    "every form), sign-in button label, accent color or the server's own, background (none, a " +
    "color, an https image URL, or the server banner; uploaded images are picked in the " +
    "dashboard), show the server icon, show moderator names (off keeps staff anonymous), show " +
    "case reasons, link from the server's public page, and the submitted and closed screens.\n" +
    "- Limits: max_per_case is how many times the SAME punishment can be appealed in total (1 to " +
    "10, default 2); max_open_per_user is how many appeals one person can have waiting at once (1 " +
    "to 10, default 1). They are different settings, never set one because the user talked about " +
    "the other. Also a cooldown after a denial before trying again, a minimum Discord account " +
    "age, and roles that can't appeal.\n" +
    "- Review: the staff channel new appeals post in, roles pinged for each new appeal (up to " +
    "10), a discussion thread per appeal, whether denying needs a reason (sent to the user), and " +
    "whether the review message lists the user's other cases and appeals.\n" +
    "- Decisions: DM the user on a decision or question, the approved, denied and needs-info DM " +
    "messages (placeholders {user}, {guild}, {case}, {type}, {reason}, {link}, and {lifted} for " +
    "approvals, which says what was undone), and a single-use invite back when an approval " +
    "unbans someone, pointing at a chosen channel or the first one available.\n" +
    "- An Appeal button on punishment DMs that opens that case's appeal: on/off and its label.\n\n" +
    "Focus on: which channel staff review appeals in and who gets pinged, which punishments can " +
    "be appealed (and any wait before appealing), whether to allow manual appeals, and what the " +
    "form should ask (offer to write a solid form if they have no preference). Only bring up the " +
    "rest if the user mentions it or it clearly matters. " +
    NULL_MEANS_UNCHANGED_RULE +
    " A whole section (page, types, one type, manual, custom_options, forms, limits, review, decisions, " +
    'dm_button) can be null when nothing in it changes. An id of "" clears that setting. ' +
    "Durations are a number and unit like \"24h\", \"3d\" or \"2w\", or \"\" for none. " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    " " +
    COLOR_RULE +
    "\n\nExisting roles (role ids must come from these only; never pick a role that sounds like " +
    "a bot/managed role):\n" +
    `${entityList(ctx.roles)}\n\n` +
    "Existing text channels (channel ids must come from these only; pick a staff-only channel " +
    "for reviews when one exists):\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    "If no channel looks right for staff review, leave the review channel null and say so in " +
    "the summary. Leave anything the user didn't mention null, even when you would pick the " +
    "default.\n\n" +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action \"ready\" " +
    "with the config and a short, friendly plain-language summary of the changes (leave question " +
    "null). Never invent an id."
  );
}

export const appealsWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 6000,
  buildResultSchema: (ctx) => turnSchemaWithIds(appealsConfigSchema(), ctx),
  validateConfig: validateAppealsConfig,
  buildSystemPrompt: buildAppealsPrompt,
};
