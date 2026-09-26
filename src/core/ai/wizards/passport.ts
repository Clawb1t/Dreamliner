/**
 * Autopilot wizard for Passport (join verification). Covers the gate itself (channel, roles,
 * nickname, age check, bypass roles, timeout kick), the join ping, the persistent Verify panel,
 * every text and look-and-feel option of the web verify page (except uploaded backgrounds), and
 * Automod de-escalation. Every setting is nullable: null means "leave it as it is".
 */
import {
  ANSWER_KIND_RULE,
  COLOR_RULE,
  FULL_PLACEHOLDER_NOTE,
  NEVER_EM_DASH_RULE,
  NULL_MEANS_UNCHANGED_RULE,
  bool,
  clampInt,
  emojiList,
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
  welcomeEmbedSchema,
  type AiWizardContext,
  type AiWizardDefinition,
} from "../wizardKit.js";
import { boolOrNull, enumOrNull, idOrNull, isRec, resolveEmojiField, sanitizeWelcomeEmbed, text } from "./welcome.js";

const MAX_QUESTIONS = 6;
const EMBED_REF = { $ref: "#/$defs/welcome_embed" };

const PAGE_TEXT_FIELDS: Record<string, number> = {
  headline: 200,
  body: 2000,
  rules: 4000,
  login_button_label: 80,
  verify_button_label: 80,
  success_title: 200,
  success_body: 2000,
  already_verified_title: 200,
  already_verified_body: 2000,
  not_a_member_title: 200,
  not_a_member_body: 2000,
  disabled_title: 200,
  disabled_body: 2000,
};
const PAGE_BOOL_FIELDS = [
  "inherit_accent",
  "show_server_icon",
  "show_server_name",
  "show_member_count",
  "show_user_avatar",
] as const;
/** "asset" (an uploaded image) is a dashboard-only choice. */
const PAGE_BACKGROUNDS = ["none", "color", "url", "guild_banner"] as const;

function passportConfigSchema(): Record<string, unknown> {
  const page: Record<string, Record<string, unknown>> = {};
  for (const key of Object.keys(PAGE_TEXT_FIELDS)) page[key] = nullable(str());
  for (const key of PAGE_BOOL_FIELDS) page[key] = nullable(bool());
  page.accent_color = nullable(int());
  page.background = nullable(oneOf(PAGE_BACKGROUNDS));
  page.background_color = nullable(int());
  page.background_url = nullable(str());

  return obj({
    channel_id: nullable(idOrEmpty("text_channel")),
    unverified_role_id: nullable(idOrEmpty("role")),
    grant_role_ids: nullable(idArray("role")),
    remove_role_ids: nullable(idArray("role")),
    strip_roles_until_verified: nullable(bool()),
    nickname: nullable(str()),
    bypass_role_ids: nullable(idArray("role")),
    remember_verifications: nullable(bool()),
    alt_detection: nullable(bool()),
    min_account_age_seconds: nullable(int()),
    timeout_action: nullable(oneOf(["none", "kick"])),
    timeout_seconds: nullable(int()),
    timeout_dm: nullable(str()),
    deescalation: nullable(obj({ enabled: nullable(bool()), factor: nullable(num()) })),
    ping: nullable(
      obj({
        enabled: nullable(bool()),
        ping_style: nullable(oneOf(["mention", "none"])),
        content: nullable(str()),
        embed: nullable(EMBED_REF),
        button_label: nullable(str()),
        button_emoji: nullable(str()),
        also_dm: nullable(bool()),
        delete_on_verify: nullable(bool()),
        delete_on_leave: nullable(bool()),
        delete_after_seconds: nullable(int()),
      }),
    ),
    panel: nullable(
      obj({
        content: nullable(str()),
        embed: nullable(EMBED_REF),
        button_label: nullable(str()),
        button_emoji: nullable(str()),
      }),
    ),
    page: nullable(obj(page)),
  });
}

export function buildPassportResultSchema(ctx: AiWizardContext): Record<string, unknown> {
  const schema = turnSchemaWithIds(passportConfigSchema(), ctx);
  return { ...schema, $defs: { ...(schema.$defs as Record<string, unknown>), welcome_embed: welcomeEmbedSchema() } };
}

/** An id list with unknown ids dropped; a list that ends up empty after dropping is "unchanged". */
function roleList(value: unknown, ctx: AiWizardContext): string[] | null {
  if (!Array.isArray(value)) return null;
  const kept = keepIds(value, ctx, "role") ?? [];
  return kept.length || value.length === 0 ? kept : null;
}

export function validatePassportConfig(config: Record<string, unknown>, ctx: AiWizardContext): string | null {
  config.channel_id = idOrNull(config.channel_id, ctx, "text_channel");
  config.unverified_role_id = idOrNull(config.unverified_role_id, ctx, "role");
  config.grant_role_ids = roleList(config.grant_role_ids, ctx);
  // An empty grant list would verify members into nothing: treat it as "unchanged".
  if (Array.isArray(config.grant_role_ids) && config.grant_role_ids.length === 0) config.grant_role_ids = null;
  config.remove_role_ids = roleList(config.remove_role_ids, ctx);
  config.bypass_role_ids = roleList(config.bypass_role_ids, ctx);
  config.strip_roles_until_verified = boolOrNull(config.strip_roles_until_verified);
  config.nickname = text(config.nickname, 32);
  config.remember_verifications = boolOrNull(config.remember_verifications);
  config.alt_detection = boolOrNull(config.alt_detection);
  config.min_account_age_seconds = clampInt(config.min_account_age_seconds, 0, 31_536_000);
  config.timeout_action = enumOrNull(config.timeout_action, ["none", "kick"]);
  config.timeout_seconds = clampInt(config.timeout_seconds, 0, 2_592_000);
  config.timeout_dm = text(config.timeout_dm, 2000);

  if (isRec(config.deescalation)) {
    const d = config.deescalation;
    d.enabled = boolOrNull(d.enabled);
    d.factor = typeof d.factor === "number" && Number.isFinite(d.factor) ? Math.min(1, Math.max(0, d.factor)) : null;
  } else {
    config.deescalation = null;
  }

  if (isRec(config.ping)) {
    const p = config.ping;
    p.enabled = boolOrNull(p.enabled);
    p.ping_style = enumOrNull(p.ping_style, ["mention", "none"]);
    p.content = text(p.content, 2000);
    p.embed = sanitizeWelcomeEmbed(p.embed);
    p.button_label = text(p.button_label, 80) || null;
    p.button_emoji = resolveEmojiField(p.button_emoji, ctx);
    p.also_dm = boolOrNull(p.also_dm);
    p.delete_on_verify = boolOrNull(p.delete_on_verify);
    p.delete_on_leave = boolOrNull(p.delete_on_leave);
    p.delete_after_seconds = clampInt(p.delete_after_seconds, 0, 604_800);
  } else {
    config.ping = null;
  }

  if (isRec(config.panel)) {
    const p = config.panel;
    p.content = text(p.content, 2000);
    p.embed = sanitizeWelcomeEmbed(p.embed);
    p.button_label = text(p.button_label, 80) || null;
    p.button_emoji = resolveEmojiField(p.button_emoji, ctx);
  } else {
    config.panel = null;
  }

  if (isRec(config.page)) {
    const p = config.page;
    for (const [key, max] of Object.entries(PAGE_TEXT_FIELDS)) p[key] = text(p[key], max);
    // Button labels can't be blank.
    if (p.login_button_label === "") p.login_button_label = null;
    if (p.verify_button_label === "") p.verify_button_label = null;
    for (const key of PAGE_BOOL_FIELDS) p[key] = boolOrNull(p[key]);
    p.accent_color = clampInt(p.accent_color, 0, 0xffffff);
    p.background = enumOrNull(p.background, PAGE_BACKGROUNDS);
    p.background_color = clampInt(p.background_color, 0, 0xffffff);
    p.background_url = text(p.background_url, 512);
    if (p.background === "url" && typeof p.background_url === "string" && !p.background_url.trim()) {
      p.background = null;
    }
  } else {
    config.page = null;
  }
  return null;
}

function buildPassportPrompt(ctx: AiWizardContext, questionsAsked: number): string {
  return (
    "You are helping a Discord server admin set up Dreamliner's Passport, a join-verification " +
    "gate: new members are held behind an unverified role, verify themselves on a web page, then " +
    `get the real member role(s). You are setting this up for the server "${ctx.guildName}". Ask ` +
    "ONE short, plain-language question at a time. Never mention field names, JSON, or config, ask " +
    "like a helpful person would.\n\n" +
    "What Passport can do:\n" +
    "- The verify channel (where the join ping and the persistent Verify panel post), the role " +
    "that restricts unverified members, the role(s) granted on success, and extra roles removed on success.\n" +
    "- Strip every other role on join until they verify (use with care).\n" +
    "- Set a nickname on success (template, max 32 characters, placeholders allowed).\n" +
    "- Remember verifications so a verified member who rejoins skips the gate.\n" +
    "- Bypass roles: members with any of them skip Passport. Roles you list are added to the existing bypass list.\n" +
    "- Minimum Discord account age (up to 1 year, 0 = off).\n" +
    "- Kick members who never verify after a set time (up to 30 days), with an optional DM before the kick.\n" +
    "- Alt-account detection: collects network signals at verify time to flag likely alts " +
    "(a privacy-relevant choice, mention that if you bring it up).\n" +
    "- De-escalation: treat genuinely verified members as lower risk in Automod and Incident " +
    "Response (factor 0 to 1, 0 ignores them entirely, 1 means no reduction, default 0.5).\n" +
    "- Join ping: on/off, mention the member or not, text, an optional embed, the Verify button " +
    "label and emoji, also DM the Verify link, delete the ping when they verify or leave, or " +
    "after a number of seconds (up to 7 days, 0 = keep).\n" +
    "- Persistent Verify panel: text, optional embed, button label and emoji.\n" +
    "- The web verify page: headline, body, rules block, sign-in and verify button labels, " +
    "accent color (or inherit the server's), background (none, a color, an image URL, or the " +
    "server banner), show or hide the server icon, server name, member count and the user's " +
    "avatar, and the titles/bodies of the success, already verified, not a member, and " +
    "verification off screens. Uploaded background images are picked in the dashboard.\n" +
    "- Embeds (ping and panel): title, description, color, author, thumbnail, large image URL, " +
    "footer, timestamp, and up to 25 fields.\n\n" +
    "Focus on: which role(s) verified members get, which role holds unverified members, which " +
    "channel the join ping posts in, and briefly whether to kick members who never verify and " +
    "whether to turn on alt detection. Only bring up the rest if the user mentions it or it " +
    "clearly matters. " +
    NULL_MEANS_UNCHANGED_RULE +
    " A whole section (ping, panel, page, embed, deescalation) can be null when nothing in it " +
    'changes. An id of "" clears that setting. ' +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\n" +
    FULL_PLACEHOLDER_NOTE +
    " " +
    COLOR_RULE +
    "\n\nExisting roles (role ids must come from these only; never pick a role that sounds like " +
    "a bot/managed role, e.g. named after a bot):\n" +
    `${entityList(ctx.roles)}\n\n` +
    "Existing text channels (channel_id must come from these only):\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    "This server's custom emoji (button emoji may be one of these names or a Unicode emoji):\n" +
    `${emojiList(ctx.emojis)}\n\n` +
    "If no role looks like a good fit for the unverified role, leave it null and say so in the " +
    "summary (the admin can create one and come back). timeout_seconds only matters when " +
    "timeout_action is \"kick\"; when setting up a kick, always give a timeout above 0. Times are " +
    "in seconds (convert \"a day\" to 86400 yourself). Only set ping_style to \"none\" when the " +
    "user doesn't want the member mentioned. When you turn on an embed, give it a title or " +
    "description. Leave anything the user didn't mention null, even when you would pick the " +
    "default.\n\n" +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action \"ready\" " +
    "with the config and a short, friendly plain-language summary of the changes (leave question " +
    "null). Never invent an id."
  );
}

export const passportWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 3500,
  buildResultSchema: buildPassportResultSchema,
  validateConfig: validatePassportConfig,
  buildSystemPrompt: buildPassportPrompt,
};
