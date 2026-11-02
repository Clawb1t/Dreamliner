import {
  INVITE_COUNT_ON,
  INVITE_QUICK_LEAVE_AS,
  INVITE_RAID_ACTIONS,
  INVITE_REJOIN_POLICIES,
} from "../../../config/schemas/inviteTracker.js";
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
  type IdKind,
} from "../wizardKit.js";

const MAX_QUESTIONS = 6;
const MAX_BLACKLIST_ROLES = 25;

const INVITE_PLACEHOLDER_NOTE =
  "Invite placeholders: {inviter} (mentions the inviter, \"someone\" when unknown), {inviter_name} " +
  "(the inviter's name without a ping), {inviter_id}, {invites} (the inviter's total), {invites_regular}, " +
  "{invites_left}, {invites_fake}, {invites_bonus}, {invite_code}, {invite_link_name} (the tracked link's " +
  "name), {join_source} (how they joined, e.g. \"the vanity URL\"), {join_count} (how many times this member " +
  "has joined), {account_age} (e.g. \"3 days\"). Leave messages use {user_name} for the member who left. " +
  FULL_PLACEHOLDER_NOTE;

function richMessageSchema(): Record<string, unknown> {
  return obj({
    content: nullable(str()),
    embed: nullable(welcomeEmbedSchema()),
    card: nullable(welcomeCardSchema()),
  });
}

export function inviteTrackerConfigSchema(): Record<string, unknown> {
  return obj({
    log_channel_id: nullable(idOrEmpty("text_channel")),
    ignore_bots: nullable(bool()),
    count_on: nullable(oneOf(INVITE_COUNT_ON)),
    passport: nullable(obj({ pending_timeout_hours: nullable(int()) })),
    fake: nullable(
      obj({
        min_account_age_days: nullable(int()),
        rejoin_policy: nullable(oneOf(INVITE_REJOIN_POLICIES)),
        quick_leave_minutes: nullable(int()),
        quick_leave_as: nullable(oneOf(INVITE_QUICK_LEAVE_AS)),
      }),
    ),
    join_message: nullable(
      obj({
        enabled: nullable(bool()),
        channel_id: nullable(idOrEmpty("text_channel")),
        message: nullable(richMessageSchema()),
        unknown_message: nullable(richMessageSchema()),
      }),
    ),
    leave_message: nullable(
      obj({
        enabled: nullable(bool()),
        channel_id: nullable(idOrEmpty("text_channel")),
        message: nullable(richMessageSchema()),
      }),
    ),
    leaderboard: nullable(obj({ show_left: nullable(bool()), show_fake: nullable(bool()) })),
    raid: nullable(
      obj({
        enabled: nullable(bool()),
        threshold_joins: nullable(int()),
        window_seconds: nullable(int()),
        action: nullable(oneOf(INVITE_RAID_ACTIONS)),
        pause_minutes: nullable(int()),
        alert_role_id: nullable(idOrEmpty("role")),
      }),
    ),
    retention_days: nullable(int()),
    blacklist: nullable(obj({ role_ids: nullable(idArray("role")) })),
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

function oneOfOrNull(value: unknown, allowed: readonly string[]): string | null {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

/** A section that's not an object becomes null ("unchanged"). */
function section(config: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = config[key];
  if (!isObject(value)) {
    config[key] = null;
    return null;
  }
  return value;
}

/** An id field: null = unchanged, "" = none, otherwise must be a real id of this kind. */
function checkId(target: Record<string, unknown>, key: string, ctx: AiWizardContext, kind: IdKind): boolean {
  if (target[key] === undefined) target[key] = null;
  return validId(target[key], ctx, kind);
}

export function validateInviteTrackerConfig(config: Record<string, unknown>, ctx: AiWizardContext): string | null {
  if (!checkId(config, "log_channel_id", ctx, "text_channel")) return "Autopilot picked a log channel that doesn't exist. Please try again.";
  if (typeof config.ignore_bots !== "boolean") config.ignore_bots = null;
  config.count_on = oneOfOrNull(config.count_on, INVITE_COUNT_ON);
  config.retention_days = clampInt(config.retention_days, 30, 730);

  const passport = section(config, "passport");
  if (passport) passport.pending_timeout_hours = clampInt(passport.pending_timeout_hours, 1, 720);

  const fake = section(config, "fake");
  if (fake) {
    fake.min_account_age_days = clampInt(fake.min_account_age_days, 0, 365);
    fake.rejoin_policy = oneOfOrNull(fake.rejoin_policy, INVITE_REJOIN_POLICIES);
    fake.quick_leave_minutes = clampInt(fake.quick_leave_minutes, 0, 43_200);
    fake.quick_leave_as = oneOfOrNull(fake.quick_leave_as, INVITE_QUICK_LEAVE_AS);
  }

  for (const key of ["join_message", "leave_message"] as const) {
    const s = section(config, key);
    if (!s) continue;
    if (!checkId(s, "channel_id", ctx, "text_channel")) return "Autopilot picked a message channel that doesn't exist. Please try again.";
    if (s.enabled === true && s.channel_id === "") return "Autopilot turned a message on but didn't pick a channel. Please try again.";
    if (typeof s.enabled !== "boolean") s.enabled = null;
    s.message = sanitizeRichMessage(s.message);
    if (key === "join_message") s.unknown_message = sanitizeRichMessage(s.unknown_message);
  }

  const leaderboard = section(config, "leaderboard");
  if (leaderboard) {
    if (typeof leaderboard.show_left !== "boolean") leaderboard.show_left = null;
    if (typeof leaderboard.show_fake !== "boolean") leaderboard.show_fake = null;
  }

  const raid = section(config, "raid");
  if (raid) {
    if (!checkId(raid, "alert_role_id", ctx, "role")) return "Autopilot picked a raid alert role that doesn't exist. Please try again.";
    if (typeof raid.enabled !== "boolean") raid.enabled = null;
    raid.threshold_joins = clampInt(raid.threshold_joins, 3, 100);
    raid.window_seconds = clampInt(raid.window_seconds, 10, 600);
    raid.action = oneOfOrNull(raid.action, INVITE_RAID_ACTIONS);
    raid.pause_minutes = clampInt(raid.pause_minutes, 15, 1440);
  }

  const blacklist = section(config, "blacklist");
  if (blacklist) blacklist.role_ids = keepIds(blacklist.role_ids, ctx, "role")?.slice(0, MAX_BLACKLIST_ROLES) ?? null;
  return null;
}

export const inviteTrackerWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 3500,
  buildResultSchema: (ctx) => turnSchemaWithIds(inviteTrackerConfigSchema(), ctx),
  validateConfig: validateInviteTrackerConfig,
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up Invite Tracker: Dreamliner works out which invite " +
    "each new member used, keeps a count per inviter (regular, left, fake and bonus), can post a message " +
    "when someone joins or leaves naming who invited them, filters out alts and fake invites, can count a " +
    "join only after the member passes Passport verification, and watches for bursts of joins through one " +
    `invite (raids). You are setting this up for "${ctx.guildName}". ` +
    "Ask ONE short, plain-language question at a time. Never mention field names, JSON, or config. " +
    "Cover, in roughly this order: what they want out of it (seeing who brings people in, announcing joins " +
    "with the inviter, stopping alts and fake invites, measuring marketing links); whether joins should only " +
    "count once the member passes Passport verification (only if they use Passport); how strict fake " +
    "detection should be (minimum account age, rejoins, people who leave right away); where join and leave " +
    "messages go, if any; and whether they want raid protection. Suggest sensible defaults instead of " +
    "asking about everything. Invite Tracker never rewards invites: never offer roles, coins or prizes for " +
    "inviting people, and if asked, explain that it only tracks invites. " +
    NULL_MEANS_UNCHANGED_RULE +
    " " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nWhat each part means:\n" +
    "- log_channel_id: a staff channel for a log entry on every tracked join and leave, plus raid alerts.\n" +
    "- ignore_bots: bots added to the server never count towards anyone's invites (default true).\n" +
    "- count_on: \"join\" counts straight away, \"verified\" only once the member passes Passport. Only " +
    "choose \"verified\" when the admin says they use Passport verification.\n" +
    "- passport.pending_timeout_hours (1-720, default 72): a join still waiting on Passport after this long " +
    "counts as fake.\n" +
    "- fake: min_account_age_days (0-365, default 7, 0 = off; accounts younger than this count as fake), " +
    "rejoin_policy (count = a rejoin counts again, fake = counts as fake, ignore = not counted; default fake), " +
    "quick_leave_minutes (0-43200, 0 = off; members who leave this quickly are a quick leave) and " +
    "quick_leave_as (left or fake).\n" +
    "- join_message: enabled, channel_id, message (posted when the inviter is known) and unknown_message " +
    "(posted when there's no inviter: the vanity URL, a tracked link, a bot invite or an unknown invite). " +
    "Each message has content (max 2000 characters, one short line works well), an optional embed and an " +
    "optional generated image card. Set a message to null to keep it.\n" +
    "- leave_message: enabled, channel_id, message.\n" +
    "- leaderboard: show_left and show_fake (show those counts on the leaderboard).\n" +
    "- raid: enabled, threshold_joins (3-100, default 10) joins through one invite within window_seconds " +
    "(10-600, default 60) is a burst; action alert (post in the log channel), delete_invite (also delete that " +
    "invite) or pause_all (also pause every invite for pause_minutes, 15-1440, default 60); alert_role_id " +
    "(role pinged with raid alerts). Raid alerts go to the log channel, so set log_channel_id too when " +
    "turning raid protection on.\n" +
    "- retention_days (30-730, default 365): joins older than this are folded into daily totals.\n" +
    "- blacklist.role_ids: inviters with any of these roles never earn invites (a list replaces the current " +
    "one, null keeps it).\n" +
    "Set a whole section to null to leave it as it is. Ids are \"\" for none.\n\n" +
    "Tracked links (named invite links such as \"YouTube\" or \"Twitter bio\" for measuring marketing) are " +
    "created on the dashboard's Tracked links tab, not here. Never try to create them; if the admin wants to " +
    "measure where people come from, suggest a few link names in your summary and tell them to create them " +
    "on the Tracked links tab.\n\n" +
    INVITE_PLACEHOLDER_NOTE +
    " " +
    COLOR_RULE +
    "\n\nExisting roles (pick roles from these ids only; never pick a bot/managed role or @everyone):\n" +
    `${entityList(ctx.roles)}\n\n` +
    "Existing text channels:\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action " +
    "\"ready\" with the config and a short, friendly plain-language summary of the choices you " +
    "made (leave question null). Never invent ids.",
};
