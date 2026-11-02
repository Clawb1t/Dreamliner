import { TEAM_PERIODS, TEAM_STRIKE_ACTIONS, TEAM_WEEK_STARTS } from "../../../config/schemas/teamControl.js";
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
  type IdKind,
} from "../wizardKit.js";

const MAX_QUESTIONS = 8;
/** The free limits: the wizard never sets up more than every server can use (One raises them on the dashboard). */
const MAX_RANKS = 10;
const MAX_CHECKLIST = 10;
const MAX_THRESHOLDS = 10;
const SLUG = /^[a-z0-9_-]{1,32}$/;

function quotaSchema(): Record<string, unknown> {
  return obj({
    shift_hours: nullable(num()),
    mod_actions: nullable(int()),
    tickets: nullable(int()),
    messages: nullable(int()),
    voice_hours: nullable(num()),
  });
}

export function teamControlConfigSchema(): Record<string, unknown> {
  return obj({
    ranks: nullable({
      type: "array",
      items: obj({ id: str(), name: str(), role_id: idOrEmpty("role"), quota: nullable(quotaSchema()) }),
    }),
    manager_role_ids: nullable(idArray("role")),
    log_channel_id: nullable(idOrEmpty("text_channel")),
    shifts: nullable(
      obj({
        enabled: nullable(bool()),
        duty_role_id: nullable(idOrEmpty("role")),
        log_channel_id: nullable(idOrEmpty("text_channel")),
        allow_breaks: nullable(bool()),
        min_minutes: nullable(int()),
        max_hours: nullable(int()),
        max_on_duty: nullable(int()),
        block_on_loa: nullable(bool()),
      }),
    ),
    leave: nullable(
      obj({
        enabled: nullable(bool()),
        loa_role_id: nullable(idOrEmpty("role")),
        ra_role_id: nullable(idOrEmpty("role")),
        request_channel_id: nullable(idOrEmpty("text_channel")),
        ping_role_id: nullable(idOrEmpty("role")),
        require_reason: nullable(bool()),
        max_days: nullable(int()),
        auto_approve: nullable(bool()),
      }),
    ),
    actions: nullable(
      obj({
        enabled: nullable(bool()),
        log_channel_id: nullable(idOrEmpty("text_channel")),
        announce_channel_id: nullable(idOrEmpty("text_channel")),
        suspended_role_id: nullable(idOrEmpty("role")),
        dm_member: nullable(bool()),
        strike_expiry_days: nullable(int()),
        strike_thresholds: nullable({
          type: "array",
          items: obj({ strikes: int(), action: oneOf(TEAM_STRIKE_ACTIONS), suspend_days: int() }),
        }),
      }),
    ),
    activity: nullable(
      obj({
        enabled: nullable(bool()),
        period: nullable(oneOf(TEAM_PERIODS)),
        week_start: nullable(oneOf(TEAM_WEEK_STARTS)),
        staff_channel_ids: nullable(idArray("text_channel")),
        inactivity_days: nullable(int()),
        report_channel_id: nullable(idOrEmpty("text_channel")),
      }),
    ),
    roster: nullable(obj({ enabled: nullable(bool()), channel_id: nullable(idOrEmpty("text_channel")), title: nullable(str()) })),
    onboarding: nullable(
      obj({
        enabled: nullable(bool()),
        checklist: nullable({ type: "array", items: obj({ id: str(), label: str(), description: str() }) }),
        trial_rank_id: nullable(str()),
        trial_days: nullable(int()),
        review_channel_id: nullable(idOrEmpty("text_channel")),
        dm_welcome: nullable(bool()),
      }),
    ),
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stable slug from a name ("Senior Mod" → "senior_mod"), unique within `taken`. */
export function slugFor(raw: unknown, fallback: string, taken: Set<string>): string {
  const given = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  let base = SLUG.test(given)
    ? given
    : given
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 24);
  if (!base) base = fallback;
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base.slice(0, 28)}_${i}`;
  taken.add(slug);
  return slug;
}

function clampNum(value: unknown, min: number, max: number, decimals: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.min(max, Math.max(min, Math.round(value * f) / f));
}

/** An id field: null = unchanged, "" = none, otherwise must be a real id of this kind. */
function checkId(section: Record<string, unknown>, key: string, ctx: AiWizardContext, kind: IdKind): boolean {
  const value = section[key];
  if (value === undefined) section[key] = null;
  return validId(section[key], ctx, kind);
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.trim().slice(0, max) : null;
}

export function validateTeamControlConfig(config: Record<string, unknown>, ctx: AiWizardContext): string | null {
  if (config.ranks !== null && config.ranks !== undefined) {
    const raw = Array.isArray(config.ranks) ? config.ranks.filter(isObject) : [];
    const taken = new Set<string>();
    const ranks = [];
    for (const [i, r] of raw.slice(0, MAX_RANKS).entries()) {
      const name = text(r.name, 32) || `Rank ${i + 1}`;
      if (r.role_id !== "" && !validId(r.role_id, ctx, "role")) return "Autopilot picked a rank role that doesn't exist. Please try again.";
      const q = isObject(r.quota) ? r.quota : null;
      ranks.push({
        id: slugFor(r.id || name, `rank_${i + 1}`, taken),
        name,
        role_id: typeof r.role_id === "string" ? r.role_id : "",
        quota: q
          ? {
              shift_hours: clampNum(q.shift_hours, 0, 500, 1),
              mod_actions: clampInt(q.mod_actions, 0, 10_000),
              tickets: clampInt(q.tickets, 0, 10_000),
              messages: clampInt(q.messages, 0, 100_000),
              voice_hours: clampNum(q.voice_hours, 0, 500, 1),
            }
          : null,
      });
    }
    // The same role on two ranks would make both the same rank.
    const roles = ranks.map((r) => r.role_id).filter(Boolean);
    if (new Set(roles).size !== roles.length) return "Autopilot linked one role to two ranks. Please try again.";
    config.ranks = ranks;
  } else {
    config.ranks = null;
  }

  config.manager_role_ids = keepIds(config.manager_role_ids, ctx, "role");
  if (!validId(config.log_channel_id ?? null, ctx, "text_channel")) return "Autopilot picked a log channel that doesn't exist. Please try again.";
  config.log_channel_id = config.log_channel_id ?? null;

  const sections: Array<[string, Array<[string, IdKind]>]> = [
    ["shifts", [["duty_role_id", "role"], ["log_channel_id", "text_channel"]]],
    ["leave", [["loa_role_id", "role"], ["ra_role_id", "role"], ["request_channel_id", "text_channel"], ["ping_role_id", "role"]]],
    ["actions", [["log_channel_id", "text_channel"], ["announce_channel_id", "text_channel"], ["suspended_role_id", "role"]]],
    ["activity", [["report_channel_id", "text_channel"]]],
    ["roster", [["channel_id", "text_channel"]]],
    ["onboarding", [["review_channel_id", "text_channel"]]],
  ];
  for (const [name, ids] of sections) {
    const section = config[name];
    if (section === null || section === undefined) {
      config[name] = null;
      continue;
    }
    if (!isObject(section)) {
      config[name] = null;
      continue;
    }
    for (const [key, kind] of ids) {
      if (!checkId(section, key, ctx, kind)) return `Autopilot picked a ${kind === "role" ? "role" : "channel"} that doesn't exist. Please try again.`;
    }
  }

  if (isObject(config.shifts)) {
    const s = config.shifts;
    s.min_minutes = clampInt(s.min_minutes, 0, 120);
    s.max_hours = clampInt(s.max_hours, 1, 48);
    s.max_on_duty = clampInt(s.max_on_duty, 0, 500);
  }
  if (isObject(config.leave)) config.leave.max_days = clampInt(config.leave.max_days, 1, 365);
  if (isObject(config.actions)) {
    const a = config.actions;
    a.strike_expiry_days = clampInt(a.strike_expiry_days, 0, 730);
    if (a.strike_thresholds !== null && a.strike_thresholds !== undefined) {
      const raw = Array.isArray(a.strike_thresholds) ? a.strike_thresholds.filter(isObject) : [];
      a.strike_thresholds = raw.slice(0, MAX_THRESHOLDS).map((t) => ({
        strikes: clampInt(t.strikes, 1, 20) ?? 3,
        action: (TEAM_STRIKE_ACTIONS as readonly unknown[]).includes(t.action) ? t.action : "notify",
        suspend_days: clampInt(t.suspend_days, 1, 90) ?? 7,
      }));
    } else {
      a.strike_thresholds = null;
    }
  }
  if (isObject(config.activity)) {
    const a = config.activity;
    a.staff_channel_ids = keepIds(a.staff_channel_ids, ctx, "text_channel")?.slice(0, 50) ?? null;
    a.inactivity_days = clampInt(a.inactivity_days, 0, 60);
  }
  if (isObject(config.roster)) {
    const title = text(config.roster.title, 100);
    config.roster.title = title || null;
  }
  if (isObject(config.onboarding)) {
    const o = config.onboarding;
    o.trial_days = clampInt(o.trial_days, 0, 90);
    if (o.checklist !== null && o.checklist !== undefined) {
      const taken = new Set<string>();
      const raw = Array.isArray(o.checklist) ? o.checklist.filter(isObject) : [];
      o.checklist = raw
        .map((item, i) => ({ item, label: text(item.label, 80), i }))
        .filter(({ label }) => Boolean(label))
        .slice(0, MAX_CHECKLIST)
        .map(({ item, label, i }) => ({ id: slugFor(item.id || label, `item_${i + 1}`, taken), label: label!, description: text(item.description, 200) ?? "" }));
    } else {
      o.checklist = null;
    }
    // The trial rank must be one of the ranks in this result (or an id already in use).
    if (typeof o.trial_rank_id === "string") {
      const ids = Array.isArray(config.ranks) ? (config.ranks as Array<{ id: string; name: string }>) : null;
      const match = ids?.find((r) => r.id === o.trial_rank_id || r.name.toLowerCase() === String(o.trial_rank_id).toLowerCase());
      o.trial_rank_id = match ? match.id : SLUG.test(o.trial_rank_id) && !ids ? o.trial_rank_id : o.trial_rank_id === "" ? "" : null;
    } else {
      o.trial_rank_id = null;
    }
  }
  return null;
}

export const teamControlWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 3500,
  buildResultSchema: (ctx) => turnSchemaWithIds(teamControlConfigSchema(), ctx),
  validateConfig: validateTeamControlConfig,
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up Team Control, Dreamliner's staff management: " +
    "a ladder of staff ranks (each linked to a Discord role), shifts where staff clock in and out, " +
    "leave of absence (LOA) and reduced activity (RA) requests, promotions, demotions, warnings, " +
    "strikes, suspensions and terminations, activity quotas per rank, a live roster message, and " +
    `onboarding checklists with a trial period for new staff. You are setting this up for "${ctx.guildName}". ` +
    "Ask ONE short, plain-language question at a time. Never mention field names, JSON, or config. " +
    "Cover, in roughly this order: how big the team is and which existing roles are the staff ranks, " +
    "from lowest to highest (match by name, e.g. Trial Mod, Moderator, Senior Mod, Admin; never invent " +
    "ranks for roles that don't exist, and leave role_id \"\" if no role fits); whether they want shifts " +
    "and an on-duty role; whether staff can request leave and where requests are reviewed; discipline " +
    "and what happens after several strikes; how activity is measured (weekly, every two weeks or " +
    "monthly) and any quotas per rank; whether they want a live roster and where; and an onboarding " +
    "checklist for new staff. Suggest sensible defaults instead of asking about everything. " +
    NULL_MEANS_UNCHANGED_RULE +
    " " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nWhat each part means:\n" +
    `- ranks: the whole ladder, LOWEST rank first, at most ${MAX_RANKS}. Giving ranks REPLACES the ladder, so ` +
    "include every rank; set it null to keep the current ranks. Each has id (short lowercase slug like " +
    "\"trial_mod\", letters, numbers, _ or -, max 32), name (max 32 characters), role_id (one of the role ids " +
    "below, or \"\" when no role fits; never the same role twice) and quota (null for none, or targets per " +
    "period: shift_hours and voice_hours may have one decimal like 2.5, mod_actions, tickets and messages are " +
    "whole numbers, 0 = not required).\n" +
    "- manager_role_ids: roles pinged about leave requests, alerts and trial reviews.\n" +
    "- log_channel_id: the default staff log channel for everything without its own channel.\n" +
    "- shifts: enabled, duty_role_id (role given while on shift; must not be an admin role), log_channel_id, " +
    "allow_breaks, min_minutes (0-120, shorter shifts don't count, default 5), max_hours (1-48, auto clock-out, " +
    "default 12), max_on_duty (0 = no limit), block_on_loa (staff on LOA can't clock in).\n" +
    "- leave: enabled, loa_role_id, ra_role_id, request_channel_id (where requests are reviewed), ping_role_id, " +
    "require_reason, max_days (1-365, default 60), auto_approve.\n" +
    "- actions: enabled, log_channel_id, announce_channel_id (public promotion announcements, \"\" for none), " +
    "suspended_role_id, dm_member, strike_expiry_days (0-730, 0 = never, default 90), strike_thresholds (null " +
    `to keep, or up to ${MAX_THRESHOLDS} of { strikes 1-20, action notify|demote|suspend|terminate, suspend_days 1-90 }; ` +
    "the default is notifying managers at 3 strikes).\n" +
    "- activity: enabled, period weekly|biweekly|monthly, week_start monday|sunday, staff_channel_ids (channels " +
    "whose messages count toward the messages quota), inactivity_days (0-60, alert after this many quiet days, " +
    "0 = off), report_channel_id.\n" +
    "- roster: enabled, channel_id, title (max 100 characters).\n" +
    `- onboarding: enabled, checklist (null to keep, or up to ${MAX_CHECKLIST} items of { id slug, label max 80, ` +
    "description max 200 or \"\" }), trial_rank_id (the id of the rank new staff are on trial at, from your " +
    "ranks list, or \"\" for any rank), trial_days (0-90, 0 = no trial), review_channel_id, dm_welcome.\n" +
    "Set a whole section to null to leave it as it is. Ids are \"\" for none.\n\n" +
    "Existing roles (pick roles from these ids only; never pick a bot/managed role or @everyone):\n" +
    `${entityList(ctx.roles)}\n\n` +
    "Existing text channels:\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action " +
    "\"ready\" with the config and a short, friendly plain-language summary of the choices you " +
    "made (leave question null). Never invent ids.",
};
