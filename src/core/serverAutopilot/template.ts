/**
 * Server Autopilot templates: parsing (strict for dashboard edits, forgiving for AI output) and
 * the deterministic post-processing that makes any template safe to plan and build: unique keys,
 * Discord and Autopilot limits, no dangling references, sensible access for staff/log channels,
 * and the guarantees the walkthrough answers ask for. Pure.
 */
import { z } from "zod";
import { aiMayPickNaming, namingOf, zNaming, type SAAnswers } from "./answers.js";
import { isSensitiveName } from "./detect.js";
import { DEFAULT_NAMING, nameWords, validPattern } from "./naming.js";
import { allowedExtraPermissions, isStaffPreset } from "./permissions.js";
import {
  SA_ACCESS,
  SA_CAPABILITIES,
  SA_CHANNEL_TYPES,
  SA_LIMITS,
  SA_MESSAGE_KINDS,
  SA_PLUGIN_LEVELS,
  SA_PLUGINS,
  SA_PURPOSES,
  SA_ROLE_PRESETS,
  type SAAccess,
  type SACapability,
  type SACategory,
  type SAChannel,
  type SAChannelType,
  type SAMessage,
  type SAMessageKind,
  type SANaming,
  type SAPluginName,
  type SAPermRule,
  type SAPluginSetup,
  type SAPurpose,
  type SARole,
  type SATemplate,
} from "./types.js";

// ── Small helpers ───────────────────────────────────────────────────────────

const has = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);

function str(value: unknown, max: number, fallback = ""): string {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

function int(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function color(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff ? value : null;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A key slug: lowercase letters, digits, - and _, up to 40 characters. */
export function slugKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .replace(/_{2,}/g, "_")
    .slice(0, 40);
}

function uniqueKey(wanted: string, taken: Set<string>, fallback: string): string {
  const base = slugKey(wanted) || fallback;
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base.slice(0, 36)}_${n}`;
  taken.add(key);
  return key;
}

/** One emoji (or a short emoji sequence) usable in a Discord name, else "". */
export function cleanEmoji(value: unknown): string {
  if (typeof value !== "string") return "";
  const v = value.trim();
  if (!v || /[A-Za-z0-9<>:#@`{}]/.test(v) || /\s/.test(v)) return "";
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const graphemes = [...segmenter.segment(v)].map((s) => s.segment);
  if (graphemes.length > 2 || Array.from(v).length > 12) return graphemes[0] && Array.from(graphemes[0]).length <= 12 ? graphemes[0] : "";
  return v;
}

function titleFromKey(key: string): string {
  return nameWords(key).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || "Role";
}

// ── Lenient sanitising (AI output) ──────────────────────────────────────────

function sanitizeRules(raw: unknown): SAPermRule[] {
  const caps = (v: unknown): SACapability[] => arr(v).filter((c): c is SACapability => has(SA_CAPABILITIES, c));
  return arr(raw)
    .slice(0, SA_LIMITS.permRules * 2)
    .map((item) => {
      const r = rec(item);
      return { target: str(r.target, 60), allow: caps(r.allow), deny: caps(r.deny) };
    })
    .filter((r) => r.target);
}

function sanitizeChannel(raw: unknown): SAChannel {
  const r = rec(raw);
  return {
    key: str(r.key, 60),
    base: str(r.base, 100),
    emoji: cleanEmoji(r.emoji),
    type: has(SA_CHANNEL_TYPES, r.type) ? r.type : "text",
    topic: str(r.topic, SA_LIMITS.topicMax),
    slowmode: int(r.slowmode, 0, SA_LIMITS.slowmodeMax, 0),
    nsfw: bool(r.nsfw),
    user_limit: int(r.user_limit, 0, SA_LIMITS.userLimitMax, 0),
    access: has(SA_ACCESS, r.access) ? r.access : "everyone",
    role_keys: arr(r.role_keys).filter((k): k is string => typeof k === "string").slice(0, 30),
    rules: sanitizeRules(r.rules),
    purpose: has(SA_PURPOSES, r.purpose) ? r.purpose : "other",
  };
}

function sanitizeNaming(raw: unknown, fallback: SANaming): SANaming {
  const r = rec(raw);
  if (!Object.keys(r).length) return { ...fallback };
  const parsed = zNaming.safeParse({ ...fallback, ...r });
  return parsed.success ? parsed.data : { ...fallback };
}

/** Turns any AI output into a template-shaped object (types right, lengths and ranges clamped). */
export function sanitizeTemplate(raw: unknown, fallbackNaming: SANaming = DEFAULT_NAMING): SATemplate {
  const r = rec(raw);
  return {
    id: str(r.id, 40),
    name: str(r.name, 60),
    tagline: str(r.tagline, 80),
    summary: str(r.summary, 400),
    highlights: arr(r.highlights).filter((h): h is string => typeof h === "string").map((h) => h.trim().slice(0, 120)).filter(Boolean),
    naming: sanitizeNaming(r.naming, fallbackNaming),
    roles: arr(r.roles).map((raw): SARole => {
      const role = rec(raw);
      return {
        key: str(role.key, 60),
        name: str(role.name, 100),
        color: color(role.color),
        hoist: bool(role.hoist),
        mentionable: bool(role.mentionable),
        preset: has(SA_ROLE_PRESETS, role.preset) ? role.preset : "cosmetic",
        extra_permissions: arr(role.extra_permissions).filter((p): p is string => typeof p === "string"),
        self_assignable: bool(role.self_assignable),
        group: str(role.group, 40),
      };
    }),
    categories: arr(r.categories).map((raw): SACategory => {
      const cat = rec(raw);
      return {
        key: str(cat.key, 60),
        base: str(cat.base, 100),
        emoji: cleanEmoji(cat.emoji),
        access: has(SA_ACCESS, cat.access) ? cat.access : "everyone",
        role_keys: arr(cat.role_keys).filter((k): k is string => typeof k === "string").slice(0, 30),
        rules: sanitizeRules(cat.rules),
        channels: arr(cat.channels).map(sanitizeChannel),
      };
    }),
    uncategorized: arr(r.uncategorized).map(sanitizeChannel),
    plugins: arr(r.plugins).map((raw): SAPluginSetup => {
      const p = rec(raw);
      return {
        plugin: (has(SA_PLUGINS, p.plugin) ? p.plugin : "") as SAPluginName,
        channel_key: typeof p.channel_key === "string" && p.channel_key ? p.channel_key : null,
        role_key: typeof p.role_key === "string" && p.role_key ? p.role_key : null,
        extra_role_keys: arr(p.extra_role_keys).filter((k): k is string => typeof k === "string"),
        level: has(SA_PLUGIN_LEVELS, p.level) ? p.level : "standard",
      };
    }),
    messages: arr(r.messages).map((raw): SAMessage => {
      const m = rec(raw);
      return {
        key: str(m.key, 60),
        channel_key: str(m.channel_key, 60),
        kind: (has(SA_MESSAGE_KINDS, m.kind) ? m.kind : "") as SAMessageKind,
        title: str(m.title, SA_LIMITS.messageTitleMax),
        body: str(m.body, SA_LIMITS.messageBodyMax),
        color: color(m.color),
        role_group: str(m.role_group, 40),
      };
    }),
  };
}

// ── Strict parsing (dashboard edits) ────────────────────────────────────────

const zKey = z.string().trim().min(1, "Every item needs a key.").max(60);
const zRules = z
  .array(z.object({ target: z.string().min(1).max(60), allow: z.array(z.enum(SA_CAPABILITIES)).max(SA_CAPABILITIES.length).default([]), deny: z.array(z.enum(SA_CAPABILITIES)).max(SA_CAPABILITIES.length).default([]) }))
  .max(SA_LIMITS.permRules, `At most ${SA_LIMITS.permRules} permission rules per item.`)
  .default([]);
const zEmoji = z.string().max(64).default("");
const zChannelInput = z.object({
  key: zKey,
  base: z.string().trim().min(1, "Give the channel a name.").max(100, "Names can be at most 100 characters."),
  emoji: zEmoji,
  type: z.enum(SA_CHANNEL_TYPES),
  topic: z.string().max(SA_LIMITS.topicMax, `Topics can be at most ${SA_LIMITS.topicMax} characters.`).default(""),
  slowmode: z.number().int().min(0).max(SA_LIMITS.slowmodeMax).default(0),
  nsfw: z.boolean().default(false),
  user_limit: z.number().int().min(0).max(SA_LIMITS.userLimitMax).default(0),
  access: z.enum(SA_ACCESS).default("everyone"),
  role_keys: z.array(z.string()).max(30).default([]),
  rules: zRules,
  purpose: z.enum(SA_PURPOSES).default("other"),
});
const zTemplateInput = z.object({
  id: z.string().max(40).default(""),
  name: z.string().trim().max(60).default(""),
  tagline: z.string().max(80).default(""),
  summary: z.string().max(400).default(""),
  highlights: z.array(z.string().max(200)).max(8).default([]),
  naming: z
    .object({
      channel_case: z.enum(["lower", "as_is"]),
      separator: z.enum(["-", "_", "・", "·", "︲", ""]),
      channel_pattern: z.string().refine(validPattern, "Patterns need {name} once and at most 30 characters of decoration."),
      category_pattern: z.string().refine(validPattern, "Patterns need {name} once and at most 30 characters of decoration."),
      category_case: z.enum(["upper", "title", "lower"]),
      voice_pattern: z.string().refine(validPattern, "Patterns need {name} once and at most 30 characters of decoration."),
      voice_case: z.enum(["title", "lower", "upper"]),
      font: z.enum(["normal", "small_caps", "bold", "italic", "monospace", "fullwidth"]),
      emoji_mode: z.enum(["all", "categories", "channels", "none"]),
    })
    .default({ ...DEFAULT_NAMING }),
  roles: z
    .array(
      z.object({
        key: zKey,
        name: z.string().trim().min(1, "Give the role a name.").max(100, "Names can be at most 100 characters."),
        color: z.number().int().min(0).max(0xffffff).nullable().default(null),
        hoist: z.boolean().default(false),
        mentionable: z.boolean().default(false),
        preset: z.enum(SA_ROLE_PRESETS),
        extra_permissions: z.array(z.string()).max(60).default([]),
        self_assignable: z.boolean().default(false),
        group: z.string().max(40).default(""),
      }),
    )
    .max(SA_LIMITS.roles, `At most ${SA_LIMITS.roles} roles.`)
    .default([]),
  categories: z
    .array(
      z.object({
        key: zKey,
        base: z.string().trim().min(1, "Give the category a name.").max(100),
        emoji: zEmoji,
        access: z.enum(SA_ACCESS).default("everyone"),
        role_keys: z.array(z.string()).max(30).default([]),
        rules: zRules,
        channels: z.array(zChannelInput).max(SA_LIMITS.channelsPerCategory, `At most ${SA_LIMITS.channelsPerCategory} channels per category.`).default([]),
      }),
    )
    .max(SA_LIMITS.categories, `At most ${SA_LIMITS.categories} categories.`)
    .default([]),
  uncategorized: z.array(zChannelInput).max(SA_LIMITS.channels).default([]),
  plugins: z
    .array(
      z.object({
        plugin: z.enum(SA_PLUGINS),
        channel_key: z.string().nullable().default(null),
        role_key: z.string().nullable().default(null),
        extra_role_keys: z.array(z.string()).max(30).default([]),
        level: z.enum(SA_PLUGIN_LEVELS).default("standard"),
      }),
    )
    .max(SA_PLUGINS.length * 2)
    .default([]),
  messages: z
    .array(
      z.object({
        key: zKey,
        channel_key: z.string().min(1, "Pick a channel for the message."),
        kind: z.enum(SA_MESSAGE_KINDS),
        title: z.string().max(SA_LIMITS.messageTitleMax).default(""),
        body: z.string().max(SA_LIMITS.messageBodyMax, `Messages can be at most ${SA_LIMITS.messageBodyMax} characters.`),
        color: z.number().int().min(0).max(0xffffff).nullable().default(null),
        role_group: z.string().max(40).default(""),
      }),
    )
    .max(SA_LIMITS.messages, `At most ${SA_LIMITS.messages} starter messages.`)
    .default([]),
});

export type TemplateIssue = { path: string; message: string };

/** Validates a template edited on the dashboard. Issues carry paths like `categories[1].channels[0].base`. */
export function parseTemplateInput(input: unknown): { ok: true; template: SATemplate } | { ok: false; issues: TemplateIssue[] } {
  const result = zTemplateInput.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.reduce<string>((acc, part) => (typeof part === "number" ? `${acc}[${part}]` : acc ? `${acc}.${part}` : part), ""),
        message: issue.message,
      })),
    };
  }
  const total = result.data.categories.reduce((n, c) => n + c.channels.length, 0) + result.data.uncategorized.length;
  if (total > SA_LIMITS.channels) {
    return { ok: false, issues: [{ path: "categories", message: `At most ${SA_LIMITS.channels} channels in a template (this one has ${total}).` }] };
  }
  const t = result.data;
  return {
    ok: true,
    template: {
      ...t,
      highlights: t.highlights.map((h) => h.slice(0, 120)),
      roles: t.roles.map((r) => ({ ...r })),
      categories: t.categories.map((c) => ({ ...c, emoji: cleanEmoji(c.emoji), channels: c.channels.map((ch) => ({ ...ch, emoji: cleanEmoji(ch.emoji) })) })),
      uncategorized: t.uncategorized.map((ch) => ({ ...ch, emoji: cleanEmoji(ch.emoji) })),
    },
  };
}

// ── Normalisation ───────────────────────────────────────────────────────────

export const INFO_PURPOSES: ReadonlySet<SAPurpose> = new Set(["rules", "announcements", "welcome", "verify", "faq", "updates", "roles"]);
const PRIVATE_PURPOSES: ReadonlySet<SAPurpose> = new Set(["staff_chat", "logs", "mod_logs"]);
const SLOWMODE_TYPES: ReadonlySet<SAChannelType> = new Set(["text", "forum"]);

/** Where each plugin naturally points, by channel purpose (first match wins). */
export const PLUGIN_CHANNEL_PURPOSES: Record<SAPluginName, SAPurpose[]> = {
  welcome_message: ["welcome", "general"],
  logs: ["mod_logs", "logs"],
  tickets: ["tickets"],
  role_panels: ["roles"],
  automod: ["mod_logs", "logs"],
  starboard: ["starboard"],
  counting: ["counting"],
  suggestions: ["suggestions"],
  autorole: [],
  passport: ["verify"],
  birthdays: ["birthdays", "general"],
  giveaways: ["giveaways"],
  activity_rewards: ["leveling", "bot_commands", "general"],
  invite_tracker: ["logs", "mod_logs"],
};
/** Plugins that do nothing without a channel. */
const PLUGINS_NEEDING_CHANNEL: ReadonlySet<SAPluginName> = new Set(["welcome_message", "logs", "starboard", "counting", "suggestions", "passport", "birthdays"]);

const MESSAGE_PURPOSES: Record<SAMessageKind, SAPurpose[]> = {
  rules: ["rules", "welcome", "announcements"],
  welcome_info: ["welcome", "rules", "general"],
  role_picker: ["roles", "welcome", "general"],
  faq: ["faq", "rules", "welcome"],
  announcement_intro: ["announcements", "updates", "general"],
  staff_guide: ["staff_chat"],
};
const MESSAGE_DEFAULT_TITLES: Record<SAMessageKind, string> = {
  rules: "Server rules",
  welcome_info: "Welcome!",
  role_picker: "Pick your roles",
  faq: "Frequently asked questions",
  announcement_intro: "Announcements",
  staff_guide: "Staff guide",
};

export type NormalizeResult = { template: SATemplate; notes: string[] };

type ChannelRef = { channel: SAChannel; category: SACategory | null };

function allChannels(t: SATemplate): ChannelRef[] {
  return [...t.uncategorized.map((channel) => ({ channel, category: null })), ...t.categories.flatMap((category) => category.channels.map((channel) => ({ channel, category })))];
}

function effectiveAccess(ref: ChannelRef): SAAccess {
  return ref.channel.access === "everyone" && ref.category ? ref.category.access : ref.channel.access;
}

function isHidden(access: SAAccess): boolean {
  return access === "staff_only" || access === "hidden_roles";
}

function newChannel(key: string, base: string, emoji: string, purpose: SAPurpose, access: SAAccess, topic = ""): SAChannel {
  return { key, base, emoji, type: "text", topic, slowmode: 0, nsfw: false, user_limit: 0, access, role_keys: [], rules: [], purpose };
}

/**
 * Makes a template safe and coherent. Idempotent: normalising twice gives the same template.
 * `answers` (when the template came from a generation) adds the guarantees the walkthrough asked for.
 */
export function normalizeTemplate(input: SATemplate, answers: SAAnswers | null = null): NormalizeResult {
  const notes: string[] = [];
  const t: SATemplate = structuredClone(input);

  // Naming
  if (answers && !aiMayPickNaming(answers)) t.naming = namingOf(answers);
  for (const key of ["channel_pattern", "category_pattern", "voice_pattern"] as const) {
    if (!validPattern(t.naming[key])) t.naming[key] = DEFAULT_NAMING[key];
  }

  t.name = t.name.trim().slice(0, 60) || "Autopilot layout";
  t.tagline = t.tagline.trim().slice(0, 80);
  t.summary = t.summary.trim().slice(0, 400);
  t.highlights = t.highlights.map((h) => h.trim().slice(0, 120)).filter(Boolean).slice(0, SA_LIMITS.highlights);
  t.id = slugKey(t.id) || "template";

  // Roles
  const roleKeys = new Set<string>();
  const roleNames = new Set<string>();
  const roles: SARole[] = [];
  for (const role of t.roles) {
    if (roles.length >= SA_LIMITS.roles) {
      notes.push(`Kept the first ${SA_LIMITS.roles} roles.`);
      break;
    }
    const name = role.name.trim().slice(0, 100) || titleFromKey(role.key);
    const lower = name.toLowerCase();
    if (roleNames.has(lower)) continue;
    roleNames.add(lower);
    const key = uniqueKey(role.key || name, roleKeys, "role");
    const staffish = isStaffPreset(role.preset) || role.preset === "muted" || role.preset === "bot";
    const selfAssignable = role.self_assignable && !staffish;
    roles.push({
      key,
      name,
      color: color(role.color),
      hoist: role.hoist,
      mentionable: role.mentionable,
      preset: role.preset,
      extra_permissions: allowedExtraPermissions(role.preset, role.extra_permissions),
      self_assignable: selfAssignable,
      group: selfAssignable ? role.group.trim().slice(0, 40) || "Roles" : "",
    });
  }
  t.roles = roles;
  const roleByKey = new Map(roles.map((r) => [r.key, r]));
  const hasVerifiedRole = () => t.roles.some((r) => r.preset === "verified" || r.preset === "member");

  // Verification needs a verified role.
  if (answers && answers.moderation.verification !== "none" && !t.roles.some((r) => r.preset === "verified") && t.roles.length < SA_LIMITS.roles) {
    const role: SARole = {
      key: uniqueKey("verified", roleKeys, "verified"),
      name: "Verified",
      color: null,
      hoist: false,
      mentionable: false,
      preset: "verified",
      extra_permissions: [],
      self_assignable: false,
      group: "",
    };
    t.roles.push(role);
    roleByKey.set(role.key, role);
    notes.push("Added a Verified role for verification.");
  }

  const fixRoleKeys = (keys: string[]) => [...new Set(keys.filter((k) => roleByKey.has(k)))];
  /** One rule per target (merged, later decisions win), real targets and capabilities only, no
   *  staff-only capability for non-staff, nothing both allowed and denied, at most permRules. */
  const fixRules = (rules: SAPermRule[]): SAPermRule[] => {
    const byTarget = new Map<string, { allow: Set<SACapability>; deny: Set<SACapability> }>();
    for (const rule of rules) {
      const target = rule.target.trim();
      if (target !== "everyone" && !roleByKey.has(target)) continue;
      const entry = byTarget.get(target) ?? { allow: new Set<SACapability>(), deny: new Set<SACapability>() };
      const staff = target !== "everyone" && isStaffPreset(roleByKey.get(target)!.preset);
      for (const cap of rule.deny) {
        if (!has(SA_CAPABILITIES, cap)) continue;
        entry.deny.add(cap);
        entry.allow.delete(cap);
      }
      for (const cap of rule.allow) {
        if (!has(SA_CAPABILITIES, cap) || rule.deny.includes(cap)) continue;
        if (!staff && (cap === "moderate" || cap === "ping_everyone")) continue;
        entry.allow.add(cap);
        entry.deny.delete(cap);
      }
      byTarget.set(target, entry);
    }
    const order = (set: Set<SACapability>) => SA_CAPABILITIES.filter((c) => set.has(c));
    return [...byTarget.entries()]
      .map(([target, e]) => ({ target, allow: order(e.allow), deny: order(e.deny) }))
      .filter((r) => r.allow.length || r.deny.length)
      .slice(0, SA_LIMITS.permRules);
  };
  const fixAccess = (access: SAAccess, keys: string[]): SAAccess => {
    if (access === "roles" && keys.length === 0) return "read_only";
    if (access === "hidden_roles" && keys.length === 0) return "staff_only";
    if (access === "verified_only" && !hasVerifiedRole()) return "everyone";
    return access;
  };

  // Channels and categories
  const channelKeys = new Set<string>();
  let channelCount = 0;
  let trimmed = false;
  const fixChannel = (ch: SAChannel): SAChannel | null => {
    if (channelCount >= SA_LIMITS.channels) {
      trimmed = true;
      return null;
    }
    channelCount += 1;
    const base = ch.base.trim().slice(0, 100) || nameWords(ch.key).join(" ") || "channel";
    const voice = ch.type === "voice" || ch.type === "stage";
    const keys = fixRoleKeys(ch.role_keys);
    let access = fixAccess(ch.access, keys);
    if (PRIVATE_PURPOSES.has(ch.purpose) && access !== "staff_only" && access !== "hidden_roles") access = "staff_only";
    return {
      key: uniqueKey(ch.key || base, channelKeys, "channel"),
      base,
      emoji: cleanEmoji(ch.emoji),
      type: ch.type,
      topic: voice ? "" : ch.topic.trim().slice(0, SA_LIMITS.topicMax),
      slowmode: SLOWMODE_TYPES.has(ch.type) ? int(ch.slowmode, 0, SA_LIMITS.slowmodeMax, 0) : 0,
      nsfw: ch.type === "stage" || (answers && !answers.moderation.nsfw_allowed) ? false : ch.nsfw,
      user_limit: ch.type === "voice" ? int(ch.user_limit, 0, SA_LIMITS.userLimitMax, 0) : 0,
      access,
      role_keys: keys,
      rules: fixRules(ch.rules ?? []),
      purpose: ch.purpose,
    };
  };

  t.uncategorized = t.uncategorized.map(fixChannel).filter((c): c is SAChannel => c !== null);
  const categories: SACategory[] = [];
  for (const cat of t.categories) {
    if (categories.length >= SA_LIMITS.categories) {
      notes.push(`Kept the first ${SA_LIMITS.categories} categories.`);
      break;
    }
    const keys = fixRoleKeys(cat.role_keys);
    const base = cat.base.trim().slice(0, 100) || nameWords(cat.key).join(" ") || "category";
    categories.push({
      key: uniqueKey(cat.key || base, channelKeys, "category"),
      base,
      emoji: cleanEmoji(cat.emoji),
      access: fixAccess(cat.access, keys),
      role_keys: keys,
      rules: fixRules(cat.rules ?? []),
      channels: cat.channels.slice(0, SA_LIMITS.channelsPerCategory).map(fixChannel).filter((c): c is SAChannel => c !== null),
    });
  }
  t.categories = categories;
  if (trimmed) notes.push(`Kept the first ${SA_LIMITS.channels} channels.`);

  const findByPurpose = (purposes: readonly SAPurpose[], textOnly = true): ChannelRef | null => {
    for (const purpose of purposes) {
      const ref = allChannels(t).find((r) => r.channel.purpose === purpose && (!textOnly || r.channel.type === "text" || r.channel.type === "announcement"));
      if (ref) return ref;
    }
    return null;
  };

  const staffCategory = (): SACategory | null => {
    const existing = t.categories.find((c) => c.access === "staff_only" || c.access === "hidden_roles");
    if (existing) return existing;
    if (t.categories.length >= SA_LIMITS.categories) return null;
    const cat: SACategory = { key: uniqueKey("staff", channelKeys, "staff"), base: "staff", emoji: "🛡️", access: "staff_only", role_keys: [], rules: [], channels: [] };
    t.categories.push(cat);
    return cat;
  };

  const addChannel = (cat: SACategory | null, ch: SAChannel): boolean => {
    if (channelCount >= SA_LIMITS.channels) return false;
    if (cat && cat.channels.length >= SA_LIMITS.channelsPerCategory) return false;
    channelCount += 1;
    if (cat) cat.channels.push(ch);
    else t.uncategorized.push(ch);
    return true;
  };

  if (answers) {
    // A staff area when there are staff roles or the manager asked for one.
    const wantsStaff = answers.features.includes("staff_area") || answers.roles.staff.length > 0;
    if (wantsStaff && !allChannels(t).some((r) => r.channel.purpose === "staff_chat")) {
      const cat = staffCategory();
      if (cat && addChannel(cat, newChannel(uniqueKey("staff_chat", channelKeys, "staff_chat"), "staff chat", "💬", "staff_chat", "everyone", "Private chat for the staff team."))) {
        notes.push("Added a private staff chat.");
      }
    }
    // A log channel when logs are wanted.
    const wantsLogs = answers.features.includes("logs") || answers.plugins.wanted.includes("logs");
    if (wantsLogs && !allChannels(t).some((r) => r.channel.purpose === "logs" || r.channel.purpose === "mod_logs")) {
      const cat = staffCategory();
      if (cat && addChannel(cat, newChannel(uniqueKey("mod_logs", channelKeys, "mod_logs"), "mod logs", "📋", "mod_logs", "everyone", "Moderation and server logs from Dreamliner."))) {
        notes.push("Added a private log channel.");
      }
    }
    // Verification needs somewhere to verify.
    if (answers.moderation.verification !== "none" && !allChannels(t).some((r) => r.channel.purpose === "verify")) {
      const info = t.categories.find((c) => c.channels.some((ch) => INFO_PURPOSES.has(ch.purpose))) ?? t.categories[0] ?? null;
      if (addChannel(info, newChannel(uniqueKey("verify", channelKeys, "verify"), "verify", "✅", "verify", "read_only", "Verify here to unlock the rest of the server."))) {
        notes.push("Added a verify channel.");
      }
    }
    // Info channels are read-only.
    if (answers.moderation.read_only_info) {
      for (const ref of allChannels(t)) {
        if (!["rules", "announcements", "updates"].includes(ref.channel.purpose)) continue;
        if (ref.channel.access === "everyone" || ref.channel.access === "verified_only" || ref.channel.access === "roles") ref.channel.access = "read_only";
      }
    }
    // Busy channels get a short slowmode.
    if (answers.moderation.slowmode_busy_channels) {
      for (const ref of allChannels(t)) {
        if (ref.channel.slowmode === 0 && ref.channel.type === "text" && ["general", "memes", "media", "self_promo"].includes(ref.channel.purpose)) {
          ref.channel.slowmode = ref.channel.purpose === "self_promo" ? 3600 : 5;
        }
      }
    }
    // Verification gates everything but the info channels.
    if (answers.moderation.verification !== "none" && t.roles.some((r) => r.preset === "verified")) {
      for (const cat of t.categories) {
        const info = cat.channels.length > 0 && cat.channels.filter((ch) => INFO_PURPOSES.has(ch.purpose)).length * 2 >= cat.channels.length;
        if (cat.access === "everyone" && !info) cat.access = "verified_only";
      }
      for (const ch of t.uncategorized) {
        if (ch.access === "everyone" && !INFO_PURPOSES.has(ch.purpose)) ch.access = "verified_only";
      }
    }
    // Reaction-role verification: the Verified role becomes a one-button picker.
    if (answers.moderation.verification === "reaction_role") {
      const verified = t.roles.find((r) => r.preset === "verified");
      if (verified && !t.messages.some((m) => m.kind === "role_picker" && m.role_group === "Verification")) {
        verified.self_assignable = true;
        verified.group = "Verification";
        const where = findByPurpose(["verify", "rules", "welcome"]);
        if (where) {
          t.messages.unshift({
            key: "verify_button",
            channel_key: where.channel.key,
            kind: "role_picker",
            title: "Verify",
            body: "Press the button below to confirm you've read the rules and unlock the server.",
            color: null,
            role_group: "Verification",
          });
        }
      }
    }
  }

  // Staff and log channels are never public, whatever their category says, and neither is
  // anything named like one ("admin chat", "mod logs", a "Staff" category) even when the
  // template tagged it as something else.
  for (const cat of t.categories) {
    if (!isHidden(cat.access) && isSensitiveName(cat.base)) {
      cat.access = "staff_only";
      notes.push(`Made the ${cat.base} category staff-only.`);
    }
  }
  for (const ref of allChannels(t)) {
    const sensitive = PRIVATE_PURPOSES.has(ref.channel.purpose) || isSensitiveName(ref.channel.base);
    if (sensitive && !isHidden(effectiveAccess(ref)) && !isHidden(ref.channel.access)) ref.channel.access = "staff_only";
  }
  // A rule can't make a hidden place visible to everyone (the build ignores it too); drop it so
  // the customizer doesn't show a permission that won't happen.
  const dropEveryoneView = (rules: SAPermRule[]) => rules.map((r) => (r.target === "everyone" ? { ...r, allow: r.allow.filter((c) => c !== "view") } : r)).filter((r) => r.allow.length || r.deny.length);
  for (const cat of t.categories) if (isHidden(cat.access) || cat.access === "verified_only") cat.rules = dropEveryoneView(cat.rules);
  for (const ref of allChannels(t)) {
    const access = effectiveAccess(ref);
    if (isHidden(access) || access === "verified_only") ref.channel.rules = dropEveryoneView(ref.channel.rules);
  }

  // Plugins
  const channelByKey = new Map(allChannels(t).map((r) => [r.channel.key, r]));
  const textChannel = (key: string | null) => {
    const ref = key ? channelByKey.get(key) : undefined;
    return ref && (ref.channel.type === "text" || ref.channel.type === "announcement") ? ref : null;
  };
  const wantedPlugins: SAPluginName[] = answers ? answers.plugins.wanted : [];
  const plugins: SAPluginSetup[] = [];
  const seenPlugins = new Set<string>();
  const pushPlugin = (p: SAPluginSetup) => {
    if (!has(SA_PLUGINS, p.plugin) || seenPlugins.has(p.plugin)) return;
    if (answers && !answers.plugins.auto && !wantedPlugins.includes(p.plugin)) return;
    const role = p.role_key && roleByKey.has(p.role_key) ? roleByKey.get(p.role_key)! : null;
    let channelRef = textChannel(p.channel_key);
    if (!channelRef) channelRef = findByPurpose(PLUGIN_CHANNEL_PURPOSES[p.plugin]);
    if (!channelRef && PLUGINS_NEEDING_CHANNEL.has(p.plugin)) {
      notes.push(`Skipped ${p.plugin.replace(/_/g, " ")}: it needs a channel the template doesn't have.`);
      return;
    }
    let roleKey = role?.key ?? null;
    if (p.plugin === "autorole" && role && (isStaffPreset(role.preset) || role.preset === "muted")) roleKey = null;
    if (p.plugin === "passport" && !roleKey) roleKey = t.roles.find((r) => r.preset === "verified")?.key ?? null;
    if (p.plugin === "autorole" && !roleKey) {
      roleKey = t.roles.find((r) => r.preset === (answers?.moderation.verification === "none" ? "member" : "__none__"))?.key ?? null;
      if (!roleKey) return;
    }
    seenPlugins.add(p.plugin);
    plugins.push({
      plugin: p.plugin,
      channel_key: channelRef?.channel.key ?? null,
      role_key: roleKey,
      extra_role_keys: fixRoleKeys(p.extra_role_keys).filter((k) => k !== roleKey),
      level: p.level,
    });
  };
  for (const p of t.plugins) pushPlugin(p);
  for (const name of wantedPlugins) {
    if (!seenPlugins.has(name)) pushPlugin({ plugin: name, channel_key: null, role_key: null, extra_role_keys: [], level: answers?.moderation.strictness === "strict" ? "strict" : answers?.moderation.strictness === "relaxed" ? "light" : "standard" });
  }
  t.plugins = plugins;

  // Messages
  const groups = new Set(t.roles.filter((r) => r.self_assignable).map((r) => r.group));
  const messageKeys = new Set<string>();
  const messages: SAMessage[] = [];
  const wantedKinds = answers?.messages.wanted ?? null;
  for (const m of t.messages) {
    if (messages.length >= SA_LIMITS.messages) break;
    if (!has(SA_MESSAGE_KINDS, m.kind)) continue;
    const isVerifyButton = m.kind === "role_picker" && m.role_group === "Verification";
    if (wantedKinds && !wantedKinds.includes(m.kind) && !isVerifyButton) continue;
    const body = m.body.trim().slice(0, SA_LIMITS.messageBodyMax);
    if (!body) continue;
    let where = textChannel(m.channel_key);
    if (!where) where = findByPurpose(MESSAGE_PURPOSES[m.kind]);
    if (!where) continue;
    let group = "";
    if (m.kind === "role_picker") {
      group = groups.has(m.role_group) ? m.role_group : ([...groups].find((g) => g !== "Verification") ?? "");
      if (!group) continue;
      if (messages.some((x) => x.kind === "role_picker" && x.role_group === group)) continue;
    }
    messages.push({
      key: uniqueKey(m.key || m.kind, messageKeys, "message"),
      channel_key: where.channel.key,
      kind: m.kind,
      title: m.title.trim().slice(0, SA_LIMITS.messageTitleMax) || MESSAGE_DEFAULT_TITLES[m.kind],
      body,
      color: color(m.color),
      role_group: group,
    });
  }
  t.messages = messages;

  return { template: t, notes };
}

/** Every channel of a template in display order, with its category key. */
export function templateChannels(t: SATemplate): Array<{ channel: SAChannel; categoryKey: string | null }> {
  return allChannels(t).map((r) => ({ channel: r.channel, categoryKey: r.category?.key ?? null }));
}
