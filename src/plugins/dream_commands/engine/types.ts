/**
 * Custom commands, program format version 3: a Shortcuts-style command. A guild slash command
 * (with typed options) runs an ordered list of steps. Steps are actions (reply, add role, create
 * channel...) or blocks that hold nested step lists (If, Repeat, Random branch, Buttons...).
 *
 * This file is the contract between the bot and the dashboard: the site keeps a copy of these
 * types in `src/lib/customCommands.ts`. Keep them in sync.
 */

export const PROGRAM_VERSION = 3 as const;

// ── Options (slash command arguments) ───────────────────────────────────────────────────────

export const OPTION_TYPES = ["text", "integer", "number", "boolean", "user", "member", "role", "channel", "attachment"] as const;
export type OptionType = (typeof OPTION_TYPES)[number];

export const OPTION_CHANNEL_TYPES = ["text", "voice", "category", "announcement", "forum", "stage", "thread"] as const;
export type OptionChannelType = (typeof OPTION_CHANNEL_TYPES)[number];

export type OptionChoice = { name: string; value: string };

export type CommandOption = {
  /** Discord option name: 1-32 of [a-z0-9_-]. Variables read it as {option.<name>}. */
  name: string;
  description: string;
  type: OptionType;
  required: boolean;
  /** text */
  minLength?: number | null;
  maxLength?: number | null;
  /** integer / number */
  min?: number | null;
  max?: number | null;
  /** channel */
  channelTypes?: OptionChannelType[];
  /** text / integer / number: fixed choices (max 25). */
  choices?: OptionChoice[];
  /** text only: suggestions offered while typing (max 200). Not used together with choices. */
  autocomplete?: string[];
};

// ── Access ──────────────────────────────────────────────────────────────────────────────────

export type CommandAccess = {
  /** Runner needs these roles (empty = no role needed). */
  roles: string[];
  rolesMode: "any" | "all";
  /** Runner may not have any of these. */
  blockedRoles: string[];
  /** Discord permission names (PermissionFlagsBits keys) the runner must hold, all of them. */
  permissions: string[];
  /** Channels or categories it works in (empty = everywhere). Category ids cover their channels. */
  channels: string[];
  blockedChannels: string[];
  /** Who sees it in Discord's command list (default_member_permissions). Empty = everyone. */
  visibility: string[];
};

export type CommandCooldowns = { user: number; channel: number; global: number };
export type CommandLimits = { perUserDaily: number; guildDaily: number };

// ── Messages ────────────────────────────────────────────────────────────────────────────────

export type EmbedField = { name: string; value: string; inline: boolean };

export type EmbedSpec = {
  authorName: string;
  authorIconUrl: string;
  authorUrl: string;
  title: string;
  titleUrl: string;
  description: string;
  thumbnailUrl: string;
  imageUrl: string;
  color: number | null;
  footerText: string;
  timestamp: boolean;
  fields: EmbedField[];
};

export type ContainerSpec = {
  accentColor: number | null;
  title: string;
  body: string;
  thumbnailUrl: string;
  imageUrl: string;
  footer: string;
};

export type MessagePings = {
  /** Ping the person running the command if the text mentions them. */
  runner: boolean;
  /** Ping users picked in user/member options. */
  optionUsers: boolean;
  /** Roles allowed to ping (the builder needs Mention Everyone). */
  roles: string[];
  /** Allow @everyone / @here (the builder needs Mention Everyone). */
  everyone: boolean;
};

export type MessageSpec = {
  format: "text" | "embed" | "container";
  /** Plain text. Above the embed for "embed"; unused for "container". */
  content: string;
  /** When non-empty, one is picked at random and used as the content (text) or body (container). */
  variants: string[];
  embed: EmbedSpec;
  container: ContainerSpec;
  pings: MessagePings;
};

// ── Steps ───────────────────────────────────────────────────────────────────────────────────

export type Step = {
  /** Unique within the program: [a-z][a-z0-9_]{0,23}, e.g. "step3". Outputs: {step3.channel}. */
  id: string;
  type: string;
  /** Optional note shown on the step card. */
  label?: string;
  /** When true a failure is recorded and the run carries on. */
  continueOnError?: boolean;
  /** Skipped when true. */
  disabled?: boolean;
  config: Record<string, unknown>;
};

/** A condition inside an If branch. `negate` flips it. */
export type Condition = { type: string; negate?: boolean } & Record<string, unknown>;

export type IfBranch = { match: "all" | "any"; conditions: Condition[]; steps: Step[] };
export type WeightedBranch = { weight: number; steps: Step[] };
export type ButtonSpec = { id: string; label: string; style: "primary" | "secondary" | "success" | "danger"; emoji: string; steps: Step[] };
export type SelectOptionSpec = { id: string; label: string; description: string; emoji: string; steps: Step[] };
export type FormInput = {
  id: string;
  label: string;
  style: "short" | "paragraph";
  required: boolean;
  placeholder: string;
  minLength: number | null;
  maxLength: number | null;
};

// ── Program ─────────────────────────────────────────────────────────────────────────────────

export type CommandProgram = {
  version: typeof PROGRAM_VERSION;
  description: string;
  /** Default for reply steps whose `ephemeral` is "default". */
  ephemeral: boolean;
  options: CommandOption[];
  access: CommandAccess;
  cooldowns: CommandCooldowns;
  limits: CommandLimits;
  steps: Step[];
};

// ── Run-time values ─────────────────────────────────────────────────────────────────────────

export type VarValue = string | number | boolean | string[];
export type VarMap = Map<string, VarValue>;

// ── Caps (shared with the dashboard) ────────────────────────────────────────────────────────

export const LIMITS = {
  /** Commands per server. Discord allows 100 guild commands; Dreamliner registers no other guild-scoped ones. */
  freeCommands: 25,
  oneCommands: 100,
  discordGuildCommands: 100,
  options: 25,
  choices: 25,
  autocomplete: 200,
  /** Steps in the whole program, counting nested ones. */
  totalSteps: 120,
  /** Nesting depth of blocks. */
  depth: 6,
  /** Steps executed in one run. */
  executedSteps: 50,
  /** Wall-clock budget of one run, excluding waits (ms). */
  runBudgetMs: 25_000,
  /** Repeat N times. */
  repeatTimes: 10,
  /** Repeat for each: items. */
  repeatEach: 25,
  /** Total waiting per run (seconds). */
  waitTotalSeconds: 15 * 60,
  /** Waits up to this long run in-process; longer ones are queued in the database. */
  inlineWaitSeconds: 10,
  conditions: 10,
  branches: 10,
  buttons: 5,
  selectOptions: 25,
  formInputs: 5,
  /** How long buttons and menus a command posts keep working (hours). */
  followupHours: 24,
  programBytes: 64 * 1024,
  textLength: 2000,
  variants: 10,
  cooldownSeconds: 7 * 86400,
  dailyLimit: 100_000,
  /** Messages a bulk delete removes. */
  bulkDelete: 100,
  /** Members a "role for everyone in voice" or "for each role member" touches. */
  massMembers: 25,
  /** Concurrent runs per server. */
  guildConcurrency: 5,
  /** Runs per server per minute. */
  guildRunsPerMinute: 60,
  /** HTTP requests per server per minute. */
  httpPerMinute: 20,
  runHistory: 50,
  /** Discord API calls one run may make (sends, edits, role changes, fetches of members...). */
  apiCalls: 25,
  /** Channels/roles/threads one run may create. */
  creationsPerRun: 3,
  /** Channels/roles/threads all commands in a server may create per hour. */
  creationsPerHour: 20,
  /** DMs one run may send. */
  dmsPerRun: 3,
  /** Runs per user per minute across a server's commands. */
  userRunsPerMinute: 10,
  /** Active buttons/menus/forms stored per server. */
  followupsPerGuild: 500,
  /** Longest text a variable can hold. */
  varLength: 2000,
  /** Items a list variable can hold. */
  listItems: 100,
  /** Variables one run may hold. */
  vars: 300,
} as const;
