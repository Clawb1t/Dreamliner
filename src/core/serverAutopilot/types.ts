/**
 * Server Autopilot: shared constants and types. This file is the bot side of the bot ⇄ website
 * contract (the site mirrors these in its own types). Pure: no discord.js, no database.
 */

export const SA_LIMITS = {
  roles: 30,
  categories: 15,
  channels: 60,
  channelsPerCategory: 50,
  messages: 8,
  highlights: 5,
  nameMax: 100,
  topicMax: 1024,
  slowmodeMax: 21600,
  userLimitMax: 99,
  messageBodyMax: 3500,
  messageTitleMax: 256,
  guildChannels: 500,
  guildRoles: 250,
  decorationMax: 30,
  generationsKept: 15,
  backupsKept: 10,
  generateTemplates: 3,
  /** Permission rules per category or channel. */
  permRules: 8,
} as const;

export const SA_SERVER_TYPES = [
  "gaming", "community", "friends", "study", "creator", "streamer", "business", "brand", "roleplay", "anime",
  "art", "music", "tech", "support", "esports", "crypto", "education", "custom",
] as const;
export const SA_SIZES = ["tiny", "small", "medium", "large", "huge"] as const;
export const SA_AGES = ["all", "13plus", "18plus"] as const;
export const SA_MOODS = ["cozy", "professional", "playful", "chaotic", "aesthetic", "minimal", "dark", "wholesome", "competitive", "chill"] as const;
export const SA_PALETTES = ["auto", "pastel", "neon", "monochrome", "warm", "cool", "earthy", "brand"] as const;
export const SA_FEATURES = [
  "rules", "announcements", "welcome", "introductions", "general_chat", "off_topic", "media", "memes", "art", "clips",
  "events", "giveaways", "polls", "suggestions", "support_tickets", "faq", "starboard", "counting", "bot_commands",
  "music", "lfg", "gaming_channels", "study_rooms", "resources", "links", "partners", "staff_area", "logs", "birthdays",
  "leveling", "qotd", "self_promo", "creator_updates", "forums",
] as const;
export const SA_VOICE_AMOUNTS = ["none", "few", "some", "lots"] as const;
export const SA_STAFF_ROLES = ["owner", "admin", "moderator", "helper", "trial_mod", "event_team", "support_team", "developer", "designer"] as const;
export const SA_MEMBER_ROLES = ["verified", "member", "regular", "vip", "booster", "supporter", "veteran", "newcomer", "muted"] as const;
export const SA_SELF_ROLES = ["pronouns", "regions", "ages", "pings", "colors", "games", "platforms", "interests", "dm_status"] as const;
export const SA_ROLE_STYLES = ["plain", "emoji_prefix", "emoji_suffix", "decorated"] as const;
export const SA_STRICTNESS = ["relaxed", "standard", "strict"] as const;
export const SA_VERIFICATION = ["none", "passport", "reaction_role"] as const;
export const SA_PLUGINS = [
  "welcome_message", "logs", "tickets", "role_panels", "automod", "starboard", "counting", "suggestions", "autorole",
  "passport", "birthdays", "giveaways", "activity_rewards", "invite_tracker",
] as const;
export const SA_MESSAGE_KINDS = ["rules", "welcome_info", "role_picker", "faq", "announcement_intro", "staff_guide"] as const;
export const SA_MESSAGE_TONES = ["friendly", "formal", "fun", "short"] as const;
export const SA_MODES = ["add", "merge", "fresh"] as const;

export const SA_CHANNEL_TYPES = ["text", "voice", "forum", "stage", "announcement"] as const;
export const SA_ACCESS = ["everyone", "read_only", "staff_only", "verified_only", "roles", "hidden_roles"] as const;
/**
 * What a permission rule can switch on or off for @everyone or a template role in one category or
 * channel. Each maps to a fixed set of Discord permission bits (permissions.ts CAPABILITY_BITS).
 * "moderate" and "ping_everyone" only ever apply to staff roles.
 */
export const SA_CAPABILITIES = [
  "view", "chat", "threads", "react", "files", "embeds", "history", "polls", "external_emoji", "commands",
  "connect", "speak", "video", "soundboard", "moderate", "ping_everyone",
] as const;
export const SA_PURPOSES = [
  "rules", "announcements", "welcome", "introductions", "general", "off_topic", "media", "memes", "art", "clips",
  "events", "giveaways", "polls", "suggestions", "tickets", "faq", "starboard", "counting", "bot_commands", "music",
  "lfg", "gaming", "study", "resources", "links", "partners", "staff_chat", "logs", "mod_logs", "birthdays", "leveling",
  "qotd", "self_promo", "updates", "verify", "roles", "voice_lounge", "voice_gaming", "voice_music", "voice_study",
  "afk", "stage", "other",
] as const;
export const SA_ROLE_PRESETS = [
  "owner", "admin", "moderator", "helper", "staff", "member", "verified", "vip", "booster_like", "muted", "cosmetic", "ping", "bot",
] as const;
export const SA_PLUGIN_LEVELS = ["light", "standard", "strict"] as const;

export const SA_CHANNEL_CASES = ["lower", "as_is"] as const;
export const SA_SEPARATORS = ["-", "_", "・", "·", "︲", ""] as const;
export const SA_CATEGORY_CASES = ["upper", "title", "lower"] as const;
export const SA_VOICE_CASES = ["title", "lower", "upper"] as const;
export const SA_FONTS = ["normal", "small_caps", "bold", "italic", "monospace", "fullwidth"] as const;
export const SA_EMOJI_MODES = ["all", "categories", "channels", "none"] as const;

export type SAMode = (typeof SA_MODES)[number];
export type SAChannelType = (typeof SA_CHANNEL_TYPES)[number];
export type SAAccess = (typeof SA_ACCESS)[number];
export type SAPurpose = (typeof SA_PURPOSES)[number];
export type SARolePreset = (typeof SA_ROLE_PRESETS)[number];
export type SAPluginName = (typeof SA_PLUGINS)[number];
export type SAMessageKind = (typeof SA_MESSAGE_KINDS)[number];

export type SANaming = {
  channel_case: (typeof SA_CHANNEL_CASES)[number];
  separator: (typeof SA_SEPARATORS)[number];
  channel_pattern: string;
  category_pattern: string;
  category_case: (typeof SA_CATEGORY_CASES)[number];
  voice_pattern: string;
  voice_case: (typeof SA_VOICE_CASES)[number];
  font: (typeof SA_FONTS)[number];
  emoji_mode: (typeof SA_EMOJI_MODES)[number];
};

export type SAChannel = {
  key: string;
  base: string;
  emoji: string;
  type: SAChannelType;
  topic: string;
  slowmode: number;
  nsfw: boolean;
  user_limit: number;
  access: SAAccess;
  role_keys: string[];
  /** Fine-grained permission rules on top of `access` (the AI's per-role decisions). */
  rules: SAPermRule[];
  purpose: SAPurpose;
};

export type SACapability = (typeof SA_CAPABILITIES)[number];
/** One permission overwrite decision: `target` is "everyone" or a template role key. */
export type SAPermRule = { target: string; allow: SACapability[]; deny: SACapability[] };

export type SACategory = { key: string; base: string; emoji: string; access: SAAccess; role_keys: string[]; rules: SAPermRule[]; channels: SAChannel[] };

export type SARole = {
  key: string;
  name: string;
  color: number | null;
  hoist: boolean;
  mentionable: boolean;
  preset: SARolePreset;
  extra_permissions: string[];
  self_assignable: boolean;
  group: string;
};

export type SAPluginSetup = {
  plugin: SAPluginName;
  channel_key: string | null;
  role_key: string | null;
  extra_role_keys: string[];
  level: (typeof SA_PLUGIN_LEVELS)[number];
};

export type SAMessage = {
  key: string;
  channel_key: string;
  kind: SAMessageKind;
  title: string;
  body: string;
  color: number | null;
  role_group: string;
};

export type SATemplate = {
  id: string;
  name: string;
  tagline: string;
  summary: string;
  highlights: string[];
  naming: SANaming;
  roles: SARole[];
  categories: SACategory[];
  uncategorized: SAChannel[];
  plugins: SAPluginSetup[];
  messages: SAMessage[];
};

export type SAOp =
  | { op: "create_role"; key: string; name: string; color: number | null }
  | { op: "update_role"; roleId: string; key: string; from: string; to: string; changes: string[] }
  | { op: "delete_role"; roleId: string; name: string }
  | { op: "create_category" | "create_channel"; key: string; name: string; type: string; parentKey: string | null }
  | { op: "update_channel"; channelId: string; key: string; from: string; to: string; changes: string[] }
  | { op: "delete_channel"; channelId: string; name: string; type: string; messageWarning: boolean }
  | { op: "reorder"; count: number }
  | { op: "configure_plugin"; plugin: string; summary: string }
  | { op: "post_message"; key: string; channelKey: string; title: string };

export type SAPlan = {
  mode: SAMode;
  ops: SAOp[];
  counts: { create: number; update: number; delete: number; plugins: number; messages: number };
  warnings: string[];
  blockers: string[];
  requiresConfirm: boolean;
  estimatedSeconds: number;
};

export type SAStepId = "backup" | "roles" | "categories" | "channels" | "permissions" | "order" | "cleanup" | "plugins" | "messages";
export type SAStepStatus = "pending" | "running" | "done" | "skipped" | "failed";
export type SAStep = { id: SAStepId; label: string; status: SAStepStatus; done: number; total: number; note: string };

export type SAPerson = { userId: string; name: string; avatarUrl: string | null };

export type SABuildResult = {
  created: number;
  updated: number;
  deleted: number;
  channels: Array<{ key: string; id: string; name: string }>;
  messages: number;
  plugins: string[];
};

export type SABuild = {
  id: number;
  kind: "build" | "restore";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  mode: SAMode | null;
  templateName: string | null;
  steps: SAStep[];
  errors: Array<{ step: string; message: string }>;
  backupId: number | null;
  createdBy: SAPerson | null;
  createdAt: string;
  finishedAt: string | null;
  result: SABuildResult | null;
};

export type SAExistingChannelType = "text" | "voice" | "forum" | "stage" | "announcement" | "other";
export type SAExistingChannel = { id: string; name: string; type: SAExistingChannelType; position: number; topic: string; protected: boolean };
export type SAStructure = {
  categories: Array<{ id: string; name: string; position: number; channels: SAExistingChannel[] }>;
  uncategorized: SAExistingChannel[];
  roles: Array<{ id: string; name: string; color: number; position: number; managed: boolean; editable: boolean; members: number }>;
};

export const STEP_LABELS: Record<SAStepId, string> = {
  backup: "Backing up your server",
  roles: "Roles",
  categories: "Categories",
  channels: "Channels",
  permissions: "Permissions",
  order: "Ordering",
  cleanup: "Cleaning up",
  plugins: "Dreamliner plugins",
  messages: "Starter messages",
};

export const TEXT_LIKE: ReadonlySet<SAChannelType> = new Set(["text", "announcement", "forum"]);
export const VOICE_LIKE: ReadonlySet<SAChannelType> = new Set(["voice", "stage"]);

export const STAFF_PRESETS: ReadonlySet<SARolePreset> = new Set(["owner", "admin", "moderator", "helper", "staff"]);
