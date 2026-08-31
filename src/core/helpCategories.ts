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
    blurb: "Warns, mutes, bans, lockdown, and cleanup.",
    include: [
      { plugin: "infractions" },
      { plugin: "admin" },
      { plugin: "slowmode" },
      { plugin: "utility", roots: ["clean", "bansearch"] },
    ],
  },
  {
    id: "protect",
    label: "Protection",
    blurb: "Filters, scam traps, sticky messages, and auto-clear.",
    include: [
      { plugin: "automod" },
      { plugin: "scam_protect" },
      { plugin: "passport" },
      { plugin: "persist" },
      { plugin: "autodelete" },
    ],
  },
  {
    id: "roles",
    label: "Role management",
    blurb: "Staff role assign, templates, autorole, identity restore, and pingables.",
    include: [
      { plugin: "roles" },
      { plugin: "role_manager" },
      { plugin: "autorole" },
      { plugin: "pingable_roles" },
    ],
  },
  {
    id: "self_roles",
    label: "Self-serve roles",
    blurb: "Dashboard-managed role panels and self-serve role menus members can claim.",
    include: [
      { plugin: "role_panels" },
      { plugin: "self_grantable_roles" },
    ],
  },
  {
    id: "info",
    label: "Lookups",
    blurb: "Inspect users, channels, roles, messages, and history.",
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
          "watchdog",
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
    id: "engage",
    label: "Engagement",
    blurb: "Welcomes, companion voice channels, and starboard.",
    include: [
      { plugin: "welcome_message" },
      { plugin: "companion_channels" },
      { plugin: "tts" },
    ],
  },
  {
    id: "respond",
    label: "Auto responses",
    blurb: "Tags, replies, threads, reactions, and translation.",
    include: [
      { plugin: "tags" },
      { plugin: "autoreplies" },
      { plugin: "autothreads" },
      { plugin: "autoreactions" },
      { plugin: "translation" },
    ],
  },
  {
    id: "schedule",
    label: "Scheduling",
    blurb: "Timed posts, reminders, and live counters.",
    include: [
      { plugin: "post" },
      { plugin: "reminders" },
      { plugin: "counters" },
    ],
  },
  {
    id: "custom",
    label: "Customization",
    blurb: "Custom events, aliases, and custom commands.",
    include: [
      { plugin: "custom_events" },
      { plugin: "command_aliases" },
      { plugin: "dream_commands" },
    ],
  },
  {
    id: "social",
    label: "Social",
    blurb: "Live notifications when your favorite creators post.",
    include: [{ plugin: "social" }],
  },
  {
    id: "tools",
    label: "Utilities",
    blurb: "Search, voice helpers, and everyday utilities.",
    include: [
      {
        plugin: "utility",
        roots: ["search", "voice", "nickname", "jumbo", "stealemoji", "ping", "about", "help", "reload", "vote"],
      },
      { plugin: "stats" },
    ],
  },
  {
    id: "feedback",
    label: "Feedback",
    blurb: "Server reviews and community suggestions.",
    include: [{ plugin: "reviews" }, { plugin: "suggestions" }],
  },
  {
    id: "fun",
    label: "Fun",
    blurb: "Games and light server extras: a global and server economy, plane and airline trading cards, plus anime images.",
    include: [{ plugin: "economy" }, { plugin: "planes", roots: ["planes"] }, { plugin: "anime" }],
  },
  {
    id: "support",
    label: "Support",
    blurb: "Ticket panels, staff claiming, transcripts, and support automation.",
    include: [{ plugin: "tickets" }],
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
    description: "Content filters, spam detection, and escalation ladders.",
  },
  scam_protect: {
    key: "scam_protect",
    name: "Scam Protect",
    description: "Honeypot channel that softbans anyone who posts in it.",
  },
  passport: {
    key: "passport",
    name: "Passport",
    description: "Web-gated member verification with Discord login and a human check.",
  },
  admin: { key: "admin", name: "Admin", description: "Channel lockdown and unlock." },
  persist: { key: "persist", name: "Persist", description: "Dashboard sticky messages that stay at the bottom of a channel." },
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
  role_panels: {
    key: "role_panels",
    name: "Role panels",
    description: "Dashboard-managed reaction/button role panels, with full embed customisation and a live preview.",
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
    description: "Auto-assign roles on join for humans and bots.",
  },
  member_identity: {
    key: "member_identity",
    name: "Member identity",
    description: "Save nickname, roles, and timeout when members leave, and reapply chosen parts on rejoin.",
  },
  welcome_message: {
    key: "welcome_message",
    name: "Welcomer",
    description: "Join, leave, and DM welcomes with embeds and image cards.",
  },
  tags: { key: "tags", name: "Tags", description: "Reusable text snippets." },
  post: { key: "post", name: "Scheduled posts", description: "Timed and recurring posts." },
  autodelete: {
    key: "autodelete",
    name: "Autodelete",
    description: "Dashboard-managed auto-clear: messages in a channel are deleted after a delay you set.",
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
  autothreads: {
    key: "autothreads",
    name: "Autothreads",
    description: "Start a thread on matching messages.",
  },
  translation: {
    key: "translation",
    name: "Translation",
    description: "Translate messages and auto-flag non-default languages.",
  },
  reminders: { key: "reminders", name: "Reminders", description: "Personal reminders." },
  counters: { key: "counters", name: "Counters", description: "Live counters." },
  companion_channels: {
    key: "companion_channels",
    name: "Companion channels",
    description: "Join-to-create temporary voice rooms with owner controls.",
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
    description: "Find where a member is, and when they were last seen.",
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
    name: "Custom commands",
    description: "Custom slash commands built visually on the dashboard.",
  },
  bot_customisation: {
    key: "bot_customisation",
    name: "Custom Branding",
    description: "Per-server bot avatar, banner, nickname, and bio.",
  },
  starboard: {
    key: "starboard",
    name: "Starboard",
    description: "Highlight highly reacted messages.",
  },
  reviews: {
    key: "reviews",
    name: "Reviews",
    description: "Collect star ratings and written feedback about your server.",
  },
  suggestions: {
    key: "suggestions",
    name: "Suggestions",
    description: "Community suggestions with staff review, voting, and statuses.",
  },
  tickets: {
    key: "tickets",
    name: "Tickets",
    description: "Support ticket panels, categories, staff claiming, and transcripts.",
  },
  economy: {
    key: "economy",
    name: "Economy",
    description: "A global coin economy plus a customisable per-server currency, earned by chatting and daily claims.",
  },
  anime: {
    key: "anime",
    name: "Anime",
    description: "Random neko images from Nekos.best, with a personal saved collection.",
  },
  planes: {
    key: "planes",
    name: "Trading Cards",
    description: "Collectible plane and airline trading cards: buy packs with global coins, browse your hangar, and give cards to other members.",
  },
  social: {
    key: "social",
    name: "Social Notifications",
    description: "Live YouTube upload notifications with fully customisable embeds, built on the dashboard.",
  },
  tts: {
    key: "tts",
    name: "Text-to-speech",
    description: "Speak text aloud in a voice channel with /tts, powered by local Piper text-to-speech.",
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
  slowmode: "mod",
  automod: "protect",
  scam_protect: "protect",
  passport: "protect",
  persist: "protect",
  autodelete: "protect",
  roles: "roles",
  role_manager: "roles",
  autorole: "roles",
  member_identity: "roles",
  pingable_roles: "roles",
  reaction_roles: "self_roles",
  role_buttons: "self_roles",
  role_panels: "self_roles",
  self_grantable_roles: "self_roles",
  locate_user: "info",
  name_history: "info",
  username_saver: "info",
  welcome_message: "engage",
  companion_channels: "engage",
  starboard: "engage",
  tts: "engage",
  tags: "respond",
  autoreplies: "respond",
  autothreads: "respond",
  autoreactions: "respond",
  translation: "respond",
  post: "schedule",
  reminders: "schedule",
  counters: "schedule",
  custom_events: "custom",
  command_aliases: "custom",
  dream_commands: "custom",
  utility: "tools",
  stats: "tools",
  bot_customisation: "tools",
  reviews: "feedback",
  suggestions: "feedback",
  tickets: "support",
  economy: "fun",
  planes: "fun",
  anime: "fun",
  social: "social",
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
      plugins: (byCategory.get(category.id) ?? []).filter(
        (plugin) => !["bot_customisation", "reaction_roles", "role_buttons"].includes(plugin.key),
      ),
    }))
    .filter((category) => category.plugins.length > 0);
}
