import {
  COMPANION_FEATURE_KEYS,
  COMPANION_PERMISSION_SOURCES,
  COMPANION_SETUP_TYPES,
} from "../../../config/schemas/companion.js";
import {
  ANSWER_KIND_RULE,
  NEVER_EM_DASH_RULE,
  NULL_MEANS_UNCHANGED_RULE,
  bool,
  clampInt,
  entityList,
  idOrEmpty,
  idRef,
  int,
  nullable,
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

const MAX_QUESTIONS = 6;

/** Discord voice region ids. "" lets Discord pick automatically (never the literal "automatic",
 * which is not a real region id). */
export const COMPANION_WIZARD_REGIONS = [
  "",
  "us-east",
  "us-west",
  "us-central",
  "rotterdam",
  "brazil",
  "singapore",
  "japan",
  "sydney",
  "india",
] as const;

const FEATURE_LABELS: Record<(typeof COMPANION_FEATURE_KEYS)[number], string> = {
  name: "owners can rename their room",
  limit: "owners can set a user limit",
  status: "owners can set a voice status",
  lock: "owners can lock and unlock",
  claim: "members can claim a room after the owner leaves",
  reject: "owners can reject and kick users or roles",
  permit: "owners can let users or roles into a locked or hidden room",
  ghost: "owners can hide the room from the channel list",
  lfm: "owners can post Looking for Members in the LFM channel",
  text: "owners can create a linked text channel",
  bitrate: "owners can change bitrate",
  transfer: "owners can transfer ownership",
  nsfw: "owners can mark the room NSFW (default off)",
  interface: "post a control panel in new rooms",
  interface_ping: "post a public note when someone uses the control panel (default off)",
  manage_channel: "give owners Discord's Manage Channel on their room",
  move_member: "give owners Discord's Move Members on their room",
  autotext: "always create a linked text channel with each room (default off)",
  region: "owners can change the voice region",
};

const PLUGIN_ID_FIELDS: Array<[string, IdKind]> = [
  ["log_channel_id", "text_channel"],
  ["lfm_channel_id", "text_channel"],
  ["staff_role_id", "role"],
  ["text_access_role_id", "role"],
  ["join_role_id", "role"],
  ["member_role_id", "role"],
];

export function companionConfigSchema(): Record<string, unknown> {
  const features: Record<string, Record<string, unknown>> = {};
  for (const key of COMPANION_FEATURE_KEYS) features[key] = nullable(bool());
  return obj({
    hub_channel_id: idRef("voice_channel"),
    name: nullable(str()),
    enabled: nullable(bool()),
    type: nullable(oneOf(COMPANION_SETUP_TYPES)),
    name_template: nullable(str()),
    user_limit: nullable(int()),
    bitrate: nullable(int()),
    category_id: nullable(idOrEmpty("category")),
    permission_source: nullable(oneOf(COMPANION_PERMISSION_SOURCES)),
    editable: nullable(bool()),
    auto_text: nullable(bool()),
    default_lock: nullable(bool()),
    default_ghost: nullable(bool()),
    default_nsfw: nullable(bool()),
    default_status: nullable(str()),
    region: nullable(oneOf(COMPANION_WIZARD_REGIONS)),
    dynamic_ready: nullable(int()),
    booster_bonus_user_limit: nullable(int()),
    // Server-wide Companion settings (apply to every hub), null = leave as is.
    features: nullable(obj(features)),
    log_channel_id: nullable(idOrEmpty("text_channel")),
    lfm_channel_id: nullable(idOrEmpty("text_channel")),
    staff_role_id: nullable(idOrEmpty("role")),
    text_channel_message: nullable(str()),
    text_access_role_id: nullable(idOrEmpty("role")),
    join_role_id: nullable(idOrEmpty("role")),
    member_role_id: nullable(idOrEmpty("role")),
  });
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

export function validateCompanionConfig(config: Record<string, unknown>, ctx: AiWizardContext): string | null {
  const hubChannelId = config.hub_channel_id;
  if (typeof hubChannelId !== "string" || !ctx.voiceChannels.some((c) => c.id === hubChannelId)) {
    return "Autopilot picked a voice channel that doesn't exist. Please try again.";
  }
  config.name = typeof config.name === "string" ? config.name.trim().slice(0, 80) : null;
  config.name_template = typeof config.name_template === "string" && config.name_template.trim()
    ? config.name_template.slice(0, 100)
    : null;
  config.user_limit = clampInt(config.user_limit, 0, 99);
  config.bitrate = clampInt(config.bitrate, 0, 384);
  config.dynamic_ready = clampInt(config.dynamic_ready, 1, 15);
  config.booster_bonus_user_limit = clampInt(config.booster_bonus_user_limit, 0, 99);
  config.default_status = text(config.default_status, 500);
  if (!validId(config.category_id, ctx, "category")) config.category_id = null;
  if (typeof config.region === "string") {
    const region = config.region.trim().toLowerCase();
    config.region = region === "automatic" ? "" : region.slice(0, 64);
  } else {
    config.region = null;
  }

  if (config.features !== null && typeof config.features === "object" && !Array.isArray(config.features)) {
    const raw = config.features as Record<string, unknown>;
    const features: Record<string, boolean | null> = {};
    for (const key of COMPANION_FEATURE_KEYS) features[key] = typeof raw[key] === "boolean" ? raw[key] : null;
    config.features = features;
  } else {
    config.features = null;
  }
  for (const [key, kind] of PLUGIN_ID_FIELDS) {
    if (!validId(config[key], ctx, kind)) config[key] = null;
  }
  config.text_channel_message = text(config.text_channel_message, 2000);
  return null;
}

export const companionWizard: AiWizardDefinition = {
  maxQuestions: MAX_QUESTIONS,
  maxTokens: 2500,
  requiresEntity: {
    kind: "voiceChannels",
    message: "This server has no voice channels yet. Create one first, then try Autopilot setup again.",
  },
  buildResultSchema: (ctx) => turnSchemaWithIds(companionConfigSchema(), ctx),
  validateConfig: validateCompanionConfig,
  buildSystemPrompt: (ctx, questionsAsked) =>
    "You are helping a Discord server admin set up a Companion Channels \"hub\" (a join-to-create " +
    "voice channel: members join it and Dreamliner creates a temporary personal room for them). Each " +
    "run adds one new hub, and can also change the server-wide Companion settings. " +
    `You are setting this up for the server "${ctx.guildName}". ` +
    "Ask ONE short, plain-language question at a time to figure out how they want it configured. " +
    "Never mention field names, JSON, or config, ask like a helpful person would. Only ask about " +
    "things that meaningfully change the outcome (which voice channel, how new rooms should be " +
    "named and created, size limits, and anything else clearly implied by their answers). " +
    NULL_MEANS_UNCHANGED_RULE +
    " " +
    NEVER_EM_DASH_RULE +
    " " +
    ANSWER_KIND_RULE +
    "\n\nSetup types (type): default (each person gets a room named after them), sequential (Name 1, " +
    "Name 2, ...), predefined (name built from tokens), clone (new rooms copy the hub's own " +
    "name, limit, bitrate and region), dynamic (a few empty rooms are always kept ready to join " +
    "instead of created on demand, dynamic_ready sets how many, 1 to 15).\n" +
    "Per hub options (null = default): name (dashboard label, max 80), enabled, name_template (max 100, " +
    "placeholders {user_display}, {username}, {seq}, {animals}, {colors}, {trees}, ignored for clone), " +
    "user_limit (0 to 99, 0 = unlimited), bitrate (kbps, 0 to 384, 0 = inherit), category_id (the " +
    "category new rooms go in, \"\" = the hub's own category), permission_source (\"category\" or " +
    "\"hub\": where new rooms copy their permissions from), editable (owners can rename and change " +
    "the limit), auto_text (create a private text channel with each room, also needs the autotext " +
    "feature), default_lock, default_ghost (hidden), default_nsfw, default_status (voice status set " +
    "on new rooms, max 500), region (\"\" lets Discord pick automatically, otherwise one of the listed " +
    "region ids), booster_bonus_user_limit (0 to 99 extra slots when the room owner boosts the " +
    "server, 0 = off).\n" +
    "Server-wide settings (apply to every hub, null = leave as is): features, a set of on/off " +
    "switches for what room owners can do (" +
    COMPANION_FEATURE_KEYS.map((k) => `${k}: ${FEATURE_LABELS[k]}`).join("; ") +
    "); log_channel_id (logs room create, delete, claim and transfer), lfm_channel_id (where Looking " +
    "for Members posts go), staff_role_id (can manage any room), text_channel_message (posted in new " +
    "linked text channels, max 2000, placeholders {user_display}, {channel}, {guild}), " +
    "text_access_role_id (can always see linked text channels), join_role_id (given while a member " +
    "is in a room), member_role_id (the member role used when restoring visibility after hide or " +
    "lock). Use \"\" to clear one of these channels or roles.\n\n" +
    "Existing voice channels (pick hub_channel_id from these ids only):\n" +
    `${entityList(ctx.voiceChannels)}\n\n` +
    "Existing categories:\n" +
    `${entityList(ctx.categories)}\n\n` +
    "Existing text channels:\n" +
    `${entityList(ctx.textChannels)}\n\n` +
    "Existing roles:\n" +
    `${entityList(ctx.roles)}\n\n` +
    progressInstruction(questionsAsked, MAX_QUESTIONS) +
    "Respond with action \"ask\" and a question (leave summary and config null), or action \"ready\" " +
    "with the config and a short, friendly plain-language summary of the choices you made (leave " +
    "question null). A hub always needs a real hub_channel_id from the list above, never invent one.",
};
