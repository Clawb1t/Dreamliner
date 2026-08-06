/**
 * Shared help / website category definitions.
 * `/help` command categories and the website editor sidebar both use this.
 */

export type HelpInclude = {
  plugin: string;
  /** When set, only these top-level slash command names (or aliases) belong here. */
  roots?: string[];
};

export type HelpCategory = {
  id: string;
  label: string;
  blurb: string;
  include: HelpInclude[];
};

/** Categories shown by the Discord `/help` command. */
export const HELP_CATEGORIES: HelpCategory[] = [
  {
    id: "mod",
    label: "Moderation",
    blurb: "Punishments, cleanup, and automated moderation.",
    include: [
      { plugin: "infractions" },
      { plugin: "admin" },
      { plugin: "automod" },
      { plugin: "censor" },
      { plugin: "slowmode" },
      { plugin: "persist" },
      { plugin: "utility", roots: ["clean", "bansearch"] },
    ],
  },
  {
    id: "roles",
    label: "Roles",
    blurb: "Assign, toggle, and manage roles.",
    include: [
      { plugin: "roles" },
      { plugin: "reaction_roles" },
      { plugin: "role_buttons" },
      { plugin: "self_grantable_roles" },
      { plugin: "pingable_roles" },
      { plugin: "role_manager" },
    ],
  },
  {
    id: "info",
    label: "Lookups",
    blurb: "Inspect users, channels, roles, messages, and more.",
    include: [
      {
        plugin: "utility",
        roots: [
          "info",
          "user",
          "server",
          "channel",
          "message",
          "invite",
          "role",
          "emoji",
          "snowflake",
          "rolelist",
          "level",
          "context",
          "source",
          "avatar",
          "time",
        ],
      },
      { plugin: "locate_user" },
      { plugin: "name_history" },
    ],
  },
  {
    id: "auto",
    label: "Automation",
    blurb: "Welcome messages, tags, schedules, reactions, and bots that run themselves.",
    include: [
      { plugin: "welcome_message" },
      { plugin: "tags" },
      { plugin: "post" },
      { plugin: "autodelete" },
      { plugin: "autoreactions" },
      { plugin: "autoreplies" },
      { plugin: "reminders" },
      { plugin: "counters" },
      { plugin: "companion_channels" },
      { plugin: "custom_events" },
      { plugin: "command_aliases" },
    ],
  },
  {
    id: "tools",
    label: "Server tools",
    blurb: "Search, voice helpers, stats, and everyday utilities.",
    include: [
      { plugin: "utility", roots: ["search", "voice", "nickname", "jumbo", "ping", "about", "help", "reload"] },
      { plugin: "stats" },
    ],
  },
  {
    id: "config",
    label: "Configuration",
    blurb: "Permissions and server configuration commands.",
    include: [{ plugin: "config" }],
  },
];

export type EditorPluginMeta = {
  key: string;
  name: string;
  description: string;
};

export type EditorPluginCategory = {
  id: string;
  label: string;
  description: string;
  plugins: EditorPluginMeta[];
};

const PLUGIN_DISPLAY: Record<string, EditorPluginMeta> = {
  utility: {
    key: "utility",
    name: "Utility",
    description: "Search, info, clean, voice tools, and more.",
  },
  infractions: {
    key: "infractions",
    name: "Infractions",
    description: "Warn, mute, kick, ban, and case management.",
  },
  automod: {
    key: "automod",
    name: "Automod",
    description: "Duplicate messages, rate limits, raid detection.",
  },
  censor: { key: "censor", name: "Censor", description: "Word and phrase filters." },
  admin: { key: "admin", name: "Admin", description: "Channel lockdown and unlock." },
  persist: { key: "persist", name: "Persist", description: "Sticky channel messages." },
  slowmode: {
    key: "slowmode",
    name: "Slowmode",
    description: "Per-channel and individual slowmode.",
  },
  roles: { key: "roles", name: "Roles", description: "Give, remove, and list roles." },
  reaction_roles: {
    key: "reaction_roles",
    name: "Reaction roles",
    description: "React to claim a role.",
  },
  role_buttons: {
    key: "role_buttons",
    name: "Role buttons",
    description: "Button-based role assignment.",
  },
  self_grantable_roles: {
    key: "self_grantable_roles",
    name: "Self grantable roles",
    description: "Self-serve role panels.",
  },
  pingable_roles: {
    key: "pingable_roles",
    name: "Pingable roles",
    description: "Temporarily mentionable roles.",
  },
  role_manager: {
    key: "role_manager",
    name: "Role manager",
    description: "Role templates.",
  },
  autorole: {
    key: "autorole",
    name: "Autorole",
    description: "Auto-assign roles on join.",
  },
  welcome_message: {
    key: "welcome_message",
    name: "Welcome message",
    description: "Custom join messages.",
  },
  tags: { key: "tags", name: "Tags", description: "Reusable text snippets." },
  post: { key: "post", name: "Scheduled posts", description: "Timed and recurring posts." },
  autodelete: {
    key: "autodelete",
    name: "Autodelete",
    description: "Auto-clear messages after a delay.",
  },
  autoreactions: {
    key: "autoreactions",
    name: "Autoreactions",
    description: "Auto-react to matching messages.",
  },
  autoreplies: {
    key: "autoreplies",
    name: "Autoreplies",
    description: "Auto-reply to matching messages.",
  },
  reminders: { key: "reminders", name: "Reminders", description: "Personal reminders." },
  counters: { key: "counters", name: "Counters", description: "Live counters." },
  companion_channels: {
    key: "companion_channels",
    name: "Companion channels",
    description: "Personal voice channels from a hub.",
  },
  name_history: {
    key: "name_history",
    name: "Name history",
    description: "Track nickname and username changes.",
  },
  username_saver: {
    key: "username_saver",
    name: "Username saver",
    description: "Persist username history.",
  },
  locate_user: {
    key: "locate_user",
    name: "Locate user",
    description: "Find where a member is.",
  },
  stats: { key: "stats", name: "Stats", description: "Server, user, and channel stats." },
  custom_events: {
    key: "custom_events",
    name: "Custom events",
    description: "Hook actions to Discord events.",
  },
  command_aliases: {
    key: "command_aliases",
    name: "Command aliases",
    description: "Shortcuts and message triggers.",
  },
  dream_commands: {
    key: "dream_commands",
    name: "Dreamcode commands",
    description: "Custom commands written in Dreamcode.",
  },
  starboard: {
    key: "starboard",
    name: "Starboard",
    description: "Highlight highly reacted messages.",
  },
};

/**
 * Primary category for each guild-config plugin, aligned with `/help` categories.
 * Plugins that appear under multiple help sections (e.g. utility) get one home here.
 * Extras without slash-help entries are placed next to the closest help category.
 */
const PLUGIN_PRIMARY_CATEGORY: Record<string, string> = {
  infractions: "mod",
  admin: "mod",
  automod: "mod",
  censor: "mod",
  slowmode: "mod",
  persist: "mod",
  roles: "roles",
  reaction_roles: "roles",
  role_buttons: "roles",
  self_grantable_roles: "roles",
  pingable_roles: "roles",
  role_manager: "roles",
  autorole: "roles",
  locate_user: "info",
  name_history: "info",
  username_saver: "info",
  welcome_message: "auto",
  tags: "auto",
  post: "auto",
  autodelete: "auto",
  autoreactions: "auto",
  autoreplies: "auto",
  reminders: "auto",
  counters: "auto",
  companion_channels: "auto",
  custom_events: "auto",
  command_aliases: "auto",
  dream_commands: "auto",
  utility: "tools",
  stats: "tools",
  starboard: "tools",
};

/** Plugin categories for the website config editor (and schema meta), matching `/help` labels. */
export function getEditorPluginCategories(): EditorPluginCategory[] {
  const byCategory = new Map<string, EditorPluginMeta[]>();

  for (const [pluginKey, categoryId] of Object.entries(PLUGIN_PRIMARY_CATEGORY)) {
    const display = PLUGIN_DISPLAY[pluginKey];
    if (!display) continue;
    const list = byCategory.get(categoryId) ?? [];
    list.push(display);
    byCategory.set(categoryId, list);
  }

  return HELP_CATEGORIES.filter((category) => category.id !== "config")
    .map((category) => ({
      id: category.id,
      label: category.label,
      description: category.blurb,
      plugins: byCategory.get(category.id) ?? [],
    }))
    .filter((category) => category.plugins.length > 0);
}
