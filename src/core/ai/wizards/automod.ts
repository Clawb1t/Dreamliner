/**
 * Autopilot "automod_setup" wizard, upgraded to cover every user-facing Automod setting
 * (zAutomodConfig in config/schemas/automod.ts): an optional preset, the global ignore lists,
 * log channel and DM toggle, native Discord AutoMod sync, the escalation bridge, and per-rule
 * overrides for any of the 22 rules (toggle, sensitivity, strike window, points, notify, case
 * reason, per-rule ignore lists, the punishment ladder, and each rule's detector settings such as
 * custom word filters, blocked link domains, caps %, mention and spam limits).
 *
 * Every field that isn't needed for the result to make sense is nullable, and null means "leave
 * this setting as it is" (the dashboard merge keeps the current draft value).
 */
import {
  AUTOMOD_ACTION_TYPES,
  AUTOMOD_PRESETS,
  AUTOMOD_RULE_IDS,
  AUTOMOD_SENSITIVITIES,
  type AutomodRuleId,
} from "../../../config/schemas/automod.js";
import { validateRegexPatternSync } from "../../regexSafety.js";
import {
  ANSWER_KIND_RULE,
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
  num,
  obj,
  oneOf,
  progressInstruction,
  str,
  turnSchemaWithIds,
  validId,
  type AiWizardContext,
  type AiWizardDefinition,
} from "../wizardKit.js";

const MAX_QUESTIONS = 5;

/** Mirrors AUTOMOD_GROUP_LABELS / AUTOMOD_RULE_META groups in src/plugins/automod/catalog.ts. */
export const AUTOMOD_WIZARD_GROUPS = ["content", "spam", "mentions_links", "presentation", "images", "raid"] as const;

const GROUP_LABELS: Record<(typeof AUTOMOD_WIZARD_GROUPS)[number], string> = {
  content: "Content filters (profanity, slurs, excessive swearing, custom word/phrase filters)",
  spam: "Spam and noise (message spam, emoji, duplicates, copypasta, stickers/GIFs, attachments, newlines, walls of text, repeated characters)",
  mentions_links: "Mentions and links (mass mentions, @everyone/@here, invite links, link spam, scam domain checks)",
  presentation: "Presentation (excessive caps, zalgo text)",
  images: "Image scanning (known scam-image reposts)",
  raid: "Join protection (raid-like bursts of new members)",
};

type NumBounds = { min: number; max: number };

/**
 * Per-rule detector settings (the rule's `settings` record) with the same bounds the dashboard's
 * rule editor uses (AutomodRuleEditor RULE_THRESHOLDS on the website). Keys not listed for a rule
 * are dropped from that rule's result.
 */
export const RULE_NUMERIC_SETTINGS: Partial<Record<AutomodRuleId, Record<string, NumBounds>>> = {
  spam: { count: { min: 2, max: 50 }, window_ms: { min: 1_000, max: 600_000 } },
  emoji_spam: { max_emoji: { min: 3, max: 50 } },
  duplicate: { max: { min: 2, max: 20 }, window_ms: { min: 1_000, max: 600_000 } },
  copypasta: { max: { min: 2, max: 20 }, window_ms: { min: 5_000, max: 3_600_000 } },
  sticker_gif_spam: { count: { min: 2, max: 30 }, window_ms: { min: 1_000, max: 600_000 } },
  attachment_spam: { count: { min: 2, max: 30 }, window_ms: { min: 1_000, max: 600_000 } },
  newline_spam: { max_newlines: { min: 4, max: 100 } },
  wall_of_text: { max_chars: { min: 200, max: 4_000 } },
  repeated_chars: { max_repeat: { min: 4, max: 40 } },
  mass_mentions: { max_mentions: { min: 2, max: 50 } },
  links: { max_links: { min: 1, max: 20 } },
  domain_intel: { min_score: { min: 1, max: 10 } },
  excessive_caps: { max_percent: { min: 40, max: 100 }, min_length: { min: 4, max: 100 } },
  zalgo: { max_marks: { min: 3, max: 50 } },
  excessive_swearing: { min_words: { min: 2, max: 20 } },
  raid: { join_count: { min: 3, max: 100 }, join_window_ms: { min: 5_000, max: 600_000 } },
  image_scan: { phash_max_distance: { min: 0, max: 20 } },
};

const NUMERIC_SETTING_KEYS = [
  ...new Set(Object.values(RULE_NUMERIC_SETTINGS).flatMap((s) => Object.keys(s ?? {}))),
];

/** Non-numeric settings and the rule that owns each. */
const LIST_SETTING_OWNERS: Record<string, AutomodRuleId> = {
  entries: "custom_filter",
  blocked_domains: "links",
  trusted_domains: "domain_intel",
  check_feeds: "domain_intel",
};

const RULE_HELP: Record<AutomodRuleId, string> = {
  profanity: "common swear words (built-in pack)",
  slurs: "hate speech and slur terms (built-in pack)",
  excessive_swearing: "many swears in one message; settings.min_words",
  custom_filter:
    "the server's own banned words, phrases, and regex patterns; settings.entries (this is where a bad-word list goes)",
  spam: "too many messages from one user; settings.count within settings.window_ms",
  emoji_spam: "too many emoji in one message; settings.max_emoji",
  duplicate: "same user repeating a message; settings.max repeats within settings.window_ms",
  copypasta: "same text pasted across the server; settings.max within settings.window_ms",
  sticker_gif_spam: "rapid stickers or GIFs; settings.count within settings.window_ms",
  attachment_spam: "rapid file uploads; settings.count within settings.window_ms",
  newline_spam: "too many line breaks; settings.max_newlines",
  wall_of_text: "very long messages; settings.max_chars",
  repeated_chars: "character floods like aaaaaaa; settings.max_repeat",
  mass_mentions: "too many different users mentioned in one message; settings.max_mentions",
  everyone_here: "@everyone or @here from members without permission to use it",
  invites: "any Discord invite link",
  links:
    "link spam; settings.max_links (links per message) and settings.blocked_domains (domains always blocked, any count)",
  domain_intel:
    "known malware and phishing links plus scam-domain heuristics; settings.min_score (lower is stricter), settings.check_feeds, settings.trusted_domains (never flagged)",
  excessive_caps: "shouting; settings.max_percent (caps percent) and settings.min_length (minimum letters)",
  zalgo: "zalgo or obfuscated text; settings.max_marks",
  image_scan: "images matching known scam-image fingerprints; settings.phash_max_distance",
  raid: "bursts of new members joining; settings.join_count within settings.join_window_ms",
};

const MAX_FILTER_ENTRIES = 250;
const MAX_DOMAINS = 200;
const MAX_LADDER_STEPS = 10;
const MAX_ACTIONS_PER_STEP = 5;
const DAY_MS = 86_400_000;

function ladderSchema(): Record<string, unknown> {
  return {
    type: "array",
    items: obj({
      after: int(),
      actions: {
        type: "array",
        items: obj({
          type: oneOf(AUTOMOD_ACTION_TYPES),
          duration_ms: nullable(int()),
          reason: nullable(str()),
          notify: nullable(bool()),
          delete_message_days: nullable(int()),
          points: nullable(int()),
        }),
      },
    }),
  };
}

function ruleSettingsSchema(): Record<string, unknown> {
  const props: Record<string, Record<string, unknown>> = {
    entries: nullable({ type: "array", items: obj({ pattern: str(), regex: bool(), enabled: bool() }) }),
    blocked_domains: nullable({ type: "array", items: str() }),
    trusted_domains: nullable({ type: "array", items: str() }),
    list_mode: nullable(oneOf(["add", "replace"])),
    check_feeds: nullable(bool()),
    // Sparse list instead of one nullable field per key: listing ~20 null keys on every rule made
    // long results prone to the model looping on whitespace until the token limit.
    thresholds: nullable({ type: "array", items: obj({ key: oneOf(NUMERIC_SETTING_KEYS), value: int() }) }),
  };
  return obj(props);
}

function ruleOverrideSchema(): Record<string, unknown> {
  return obj({
    rule_id: oneOf(AUTOMOD_RULE_IDS),
    enabled: nullable(bool()),
    sensitivity: nullable(oneOf(AUTOMOD_SENSITIVITIES)),
    strike_window_ms: nullable(int()),
    delete_message: nullable(bool()),
    points: nullable(int()),
    notify: nullable(bool()),
    case_reason: nullable(str()),
    log_silent_hits_as_cases: nullable(bool()),
    ignored_channels: nullable(idArray("text_channel")),
    ignored_roles: nullable(idArray("role")),
    ladder: nullable(ladderSchema()),
    settings: nullable(ruleSettingsSchema()),
  });
}

export function automodResultSchema(): Record<string, unknown> {
  return obj({
    preset: nullable(oneOf(AUTOMOD_PRESETS)),
    categories: nullable({ type: "array", items: oneOf(AUTOMOD_WIZARD_GROUPS) }),
    ignored_channels: nullable(idArray("text_channel")),
    ignored_roles: nullable(idArray("role")),
    log_channel_id: nullable(idOrEmpty("text_channel")),
    dm_users: nullable(bool()),
    native: nullable(
      obj({
        enabled: nullable(bool()),
        alert_channel_id: nullable(idOrEmpty("text_channel")),
        spam_detection: nullable(bool()),
        timeout_seconds: nullable(int()),
      }),
    ),
    escalation_bridge: nullable(
      obj({
        feed_real_escalation: nullable(bool()),
        use_infraction_history: nullable(bool()),
        points_per_infraction: nullable(num()),
        lookback_ms: nullable(int()),
      }),
    ),
    rules: nullable({ type: "array", items: ruleOverrideSchema() }),
  });
}

// ----- validateConfig ------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function textOrNull(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.trim().slice(0, max) : null;
}

function enumOrNull<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/** Lowercased bare hostname ("https://www.Bit.ly/x" -> "bit.ly"), or null if it isn't one. */
export function normalizeDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let d = raw.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  d = d.split(/[/?#\s]/)[0] ?? "";
  d = d.replace(/:\d+$/, "").replace(/^\*\./, "").replace(/^www\./, "").replace(/\.+$/, "");
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,}$/.test(d) ? d : null;
}

function domainList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = new Set<string>();
  for (const raw of value) {
    const d = normalizeDomain(raw);
    if (d) out.add(d);
  }
  return [...out].slice(0, MAX_DOMAINS);
}

function filterEntries(value: unknown): Rec[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const out: Rec[] = [];
  for (const raw of value) {
    const e = asRec(raw);
    if (!e || typeof e.pattern !== "string") continue;
    const pattern = e.pattern.trim().slice(0, 200);
    if (!pattern) continue;
    const regex = e.regex === true;
    if (regex && !validateRegexPatternSync(pattern, "i").ok) continue;
    const key = `${regex ? "r" : "t"}:${pattern.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pattern, regex, enabled: e.enabled !== false });
    if (out.length >= MAX_FILTER_ENTRIES) break;
  }
  return out;
}

function sanitizeLadder(value: unknown): Rec[] | null {
  if (!Array.isArray(value)) return null;
  const steps: Rec[] = [];
  for (const rawStep of value) {
    const step = asRec(rawStep);
    if (!step) continue;
    const after = clampInt(step.after, 1, 1000);
    if (after === null) continue;
    const actions: Rec[] = [];
    for (const rawAction of Array.isArray(step.actions) ? step.actions : []) {
      const a = asRec(rawAction);
      const type = enumOrNull(a?.type, AUTOMOD_ACTION_TYPES);
      if (!a || !type) continue;
      actions.push({
        type,
        duration_ms: clampInt(a.duration_ms, 0, type === "mute" ? 28 * DAY_MS : 365 * DAY_MS),
        reason: textOrNull(a.reason, 400) || null,
        notify: boolOrNull(a.notify),
        delete_message_days: clampInt(a.delete_message_days, 0, 7),
        points: clampInt(a.points, 0, 100),
      });
      if (actions.length >= MAX_ACTIONS_PER_STEP) break;
    }
    if (!actions.length) continue;
    const same = steps.find((st) => st.after === after);
    if (same) {
      const merged = same.actions as Rec[];
      merged.push(...actions.slice(0, MAX_ACTIONS_PER_STEP - merged.length));
      continue;
    }
    steps.push({ after, actions });
    if (steps.length >= MAX_LADDER_STEPS) break;
  }
  steps.sort((a, b) => (a.after as number) - (b.after as number));
  // A ladder can't be empty; an unusable one means "leave the current ladder".
  return steps.length ? steps : null;
}

function sanitizeSettings(ruleId: AutomodRuleId, value: unknown): { settings: Rec | null; numeric: boolean } {
  const raw = asRec(value);
  if (!raw) return { settings: null, numeric: false };
  // Unpack the sparse thresholds list into the rule's keyed settings.
  const s: Rec = { ...raw };
  if (Array.isArray(raw.thresholds)) {
    for (const pair of raw.thresholds) {
      const p = asRec(pair);
      if (p && typeof p.key === "string") s[p.key] = p.value;
    }
  }
  delete s.thresholds;
  const out: Rec = {};
  const bounds = RULE_NUMERIC_SETTINGS[ruleId] ?? {};
  let numeric = false;
  for (const key of NUMERIC_SETTING_KEYS) {
    const b = bounds[key];
    out[key] = b ? clampInt(s[key], b.min, b.max) : null;
    if (out[key] !== null) numeric = true;
  }
  out.entries = LIST_SETTING_OWNERS.entries === ruleId ? filterEntries(s.entries) : null;
  out.blocked_domains = LIST_SETTING_OWNERS.blocked_domains === ruleId ? domainList(s.blocked_domains) : null;
  out.trusted_domains = LIST_SETTING_OWNERS.trusted_domains === ruleId ? domainList(s.trusted_domains) : null;
  out.check_feeds = LIST_SETTING_OWNERS.check_feeds === ruleId ? boolOrNull(s.check_feeds) : null;
  const any = Object.values(out).some((v) => v !== null);
  out.list_mode = enumOrNull(s.list_mode, ["add", "replace"] as const);
  return { settings: any ? out : null, numeric };
}

function sanitizeRuleOverride(raw: Rec, ctx: AiWizardContext): Rec {
  const ruleId = raw.rule_id as AutomodRuleId;
  const { settings, numeric } = sanitizeSettings(ruleId, raw.settings);
  let sensitivity = enumOrNull(raw.sensitivity, AUTOMOD_SENSITIVITIES);
  // Exact thresholds only hold as given under "custom" (lenient/strict scale them), which is also
  // what the dashboard's rule editor switches to when a threshold is edited by hand.
  if (numeric && sensitivity === null) sensitivity = "custom";
  const caseReason = textOrNull(raw.case_reason, 400);
  return {
    rule_id: ruleId,
    enabled: boolOrNull(raw.enabled),
    sensitivity,
    strike_window_ms: clampInt(raw.strike_window_ms, 1_000, 90 * DAY_MS),
    delete_message: boolOrNull(raw.delete_message),
    points: clampInt(raw.points, 1, 100),
    notify: boolOrNull(raw.notify),
    case_reason: caseReason,
    log_silent_hits_as_cases: boolOrNull(raw.log_silent_hits_as_cases),
    ignored_channels: keepIds(raw.ignored_channels, ctx, "text_channel"),
    ignored_roles: keepIds(raw.ignored_roles, ctx, "role"),
    ladder: sanitizeLadder(raw.ladder),
    settings,
  };
}

/** Later overrides for the same rule fill in (and win over) earlier ones. */
function mergeOverrides(a: Rec, b: Rec): Rec {
  const out: Rec = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (value === null) continue;
    if (key === "settings" && asRec(out.settings)) {
      const merged: Rec = { ...(out.settings as Rec) };
      for (const [k, v] of Object.entries(value as Rec)) if (v !== null) merged[k] = v;
      out.settings = merged;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function validateAutomodConfig(config: Record<string, unknown>, ctx: AiWizardContext): string | null {
  config.preset = enumOrNull(config.preset, AUTOMOD_PRESETS);
  config.categories = Array.isArray(config.categories)
    ? [...new Set(config.categories.filter((c) => (AUTOMOD_WIZARD_GROUPS as readonly unknown[]).includes(c)))]
    : null;
  config.ignored_channels = keepIds(config.ignored_channels, ctx, "text_channel");
  config.ignored_roles = keepIds(config.ignored_roles, ctx, "role");
  config.log_channel_id =
    typeof config.log_channel_id === "string" && validId(config.log_channel_id, ctx, "text_channel")
      ? config.log_channel_id
      : null;
  config.dm_users = boolOrNull(config.dm_users);

  const native = asRec(config.native);
  config.native = native
    ? {
        enabled: boolOrNull(native.enabled),
        alert_channel_id:
          typeof native.alert_channel_id === "string" && validId(native.alert_channel_id, ctx, "text_channel")
            ? native.alert_channel_id
            : null,
        spam_detection: boolOrNull(native.spam_detection),
        timeout_seconds: clampInt(native.timeout_seconds, 0, 2_419_200),
      }
    : null;

  const bridge = asRec(config.escalation_bridge);
  config.escalation_bridge = bridge
    ? {
        feed_real_escalation: boolOrNull(bridge.feed_real_escalation),
        use_infraction_history: boolOrNull(bridge.use_infraction_history),
        points_per_infraction:
          typeof bridge.points_per_infraction === "number" && Number.isFinite(bridge.points_per_infraction)
            ? Math.min(20, Math.max(0, bridge.points_per_infraction))
            : null,
        lookback_ms: clampInt(bridge.lookback_ms, 0, 3650 * DAY_MS),
      }
    : null;

  if (Array.isArray(config.rules)) {
    const byId = new Map<string, Rec>();
    for (const raw of config.rules) {
      const r = asRec(raw);
      if (!r || !(AUTOMOD_RULE_IDS as readonly unknown[]).includes(r.rule_id)) continue;
      const clean = sanitizeRuleOverride(r, ctx);
      const prev = byId.get(clean.rule_id as string);
      byId.set(clean.rule_id as string, prev ? mergeOverrides(prev, clean) : clean);
    }
    config.rules = [...byId.values()];
  } else {
    config.rules = null;
  }
  return null;
}

// ----- Prompt --------------------------------------------------------------------------------

function buildSystemPrompt(ctx: AiWizardContext, questionsAsked: number): string {
  return (
    "You are helping a Discord server admin set up Automod: Dreamliner scans messages (and member " +
    `joins) and acts on rule hits. You are setting this up for the server "${ctx.guildName}". Ask ONE ` +
    "short, plain-language question at a time. Never mention field names, JSON, or config, ask like a " +
    "helpful person would. Good first questions: how strict overall (light, standard, or strict preset), " +
    "which kinds of problems matter most, any words or links they want blocked, and where hits should " +
    "be logged.\n\n" +
    "What Automod can do (all of it is supported, never say any of this is unsupported):\n" +
    "- One-click presets (light, standard, strict) that turn on and tune a sensible set of rules. " +
    "preset is optional: set it only when the user wants a preset (re)applied, otherwise null. Rule " +
    "overrides you give are applied on top of the preset.\n" +
    "- categories: optionally force whole groups of rules on.\n" +
    "- Global ignore lists: ignored_channels (channels Automod skips entirely) and ignored_roles " +
    "(roles that bypass Automod, usually staff). Any ignore list you give (global or per rule) " +
    "replaces the current one, so list every channel or role that should be on it.\n" +
    "- log_channel_id: channel for Automod hit logs (\"\" = fall back to the moderation log). " +
    "dm_users: DM members when Automod warns them.\n" +
    "- native: mirror supported rules (profanity, slurs, custom filter, invites, @everyone, mass " +
    "mentions) into Discord's own AutoMod so messages are blocked before sending even if the bot is " +
    "down; alert_channel_id for Discord's own alerts, spam_detection for Discord's spam model, " +
    "timeout_seconds for a native timeout on block (0 = off, max 2419200).\n" +
    "- escalation_bridge: feed_real_escalation (Automod cases count toward the Infractions plugin's " +
    "own auto escalation), use_infraction_history plus points_per_infraction (0 to 20) and lookback_ms " +
    "(0 = all time) to make members with a record escalate faster.\n" +
    "- Per-rule overrides (rules list, one entry per rule you change): enabled, sensitivity " +
    "(lenient, balanced, strict, or custom; custom means the exact thresholds in settings apply), " +
    "strike_window_ms (how long a member's points are remembered for the ladder, usually 1 hour to 1 day, " +
    "not the detector's own time window which is settings.window_ms), delete_message (delete the offending " +
    "message), points per hit (1 to 100), notify (DM the member on case actions), case_reason, " +
    "log_silent_hits_as_cases (delete or log-only hits also create a note case), per-rule " +
    "ignored_channels and ignored_roles, the punishment ladder, and detector settings.\n" +
    "- Ladder: a list of steps; each step has after (run once the member reaches this many points " +
    "inside the strike window) and actions. Action types: delete, warn, mute (a timeout, duration_ms, " +
    "max 28 days, default 10 minutes), kick, softban, ban, tempban (duration_ms), note (staff note), " +
    "none (log only). Each action can also set reason, notify, delete_message_days (0 to 7, bans) and " +
    "points (0 to 100, recorded on the case). Example \"delete, warn after 3, mute 1 hour after 5, " +
    "ban after 8\": [{after 1: delete}, {after 3: warn}, {after 5: mute 3600000}, {after 8: ban}]. " +
    "A ladder you give replaces that rule's whole ladder. When the user gives one set of actions for " +
    "everything, put that ladder on every rule you turn on.\n" +
    "- Settings lists (custom filter entries, blocked_domains, trusted_domains) are added to the " +
    "existing list by default; set settings.list_mode to \"replace\" only when the user wants the " +
    "whole list swapped. Custom filter entries are plain words or phrases (matched anywhere, case " +
    "insensitive) or regex patterns (regex true, keep backslashes such as \\s intact), max 200 " +
    "characters each. Domains are bare hostnames like bit.ly (subdomains are included). Numeric detector " +
    "settings (min_words, count, window_ms, max_mentions, max_percent and so on) go in settings.thresholds as " +
    "{key, value} pairs, listing only the ones you change. Leave settings null for rules whose settings don't change.\n" +
    "- Times are milliseconds (10 seconds = 10000, 1 hour = 3600000, 1 day = 86400000).\n\n" +
    "Rules (rule_id: what it catches and its settings):\n" +
    AUTOMOD_RULE_IDS.map((id) => `${id}: ${RULE_HELP[id]}`).join("\n") +
    "\n\nThere is no invite allowlist and no link allowlist: invites blocks every Discord invite, and " +
    "links blocks by count or by blocked domain. For \"only allow some links\", suggest per-rule " +
    "ignored channels or roles instead, or trusted_domains for the scam-domain check.\n\n" +
    "Categories (for categories):\n" +
    Object.entries(GROUP_LABELS)
      .map(([id, label]) => `"${id}": ${label}`)
      .join("\n") +
    "\n\nImporting from another bot (Dyno, MEE6, Carl, etc.): map a bad-word list to custom_filter " +
    "entries, a link blacklist to links.blocked_domains, an invite filter to invites, caps limits to " +
    "excessive_caps, mention limits to mass_mentions, message rate limits to spam, and actions like " +
    "\"warn then mute after N\" to ladders. Actions or punishments stated once for the whole setup (not " +
    "for one filter) apply to EVERY rule you enable, so give each of those rules that same ladder. Keep " +
    "ignored channels and roles and the log channel.\n\n" +
    NULL_MEANS_UNCHANGED_RULE +
    " " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nText channels (ids for channel fields):\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    "Roles (ids for role fields):\n" +
    `${entityList(ctx.roles)}\n\n` +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action \"ready\" " +
    "with the config and a short, friendly plain-language summary of what you set (leave question null)."
  );
}

export const automodWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 6000,
  buildSystemPrompt,
  buildResultSchema: (ctx) => turnSchemaWithIds(automodResultSchema(), ctx),
  validateConfig: validateAutomodConfig,
};
