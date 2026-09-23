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
    blurb: "Warns, mutes, bans, and cleanup.",
    include: [
      { plugin: "infractions" },
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
      { plugin: "impersonation" },
      { plugin: "incident_response" },
      { plugin: "raid_mesh" },
      { plugin: "scam_protect" },
      { plugin: "passport" },
      { plugin: "persist" },
      { plugin: "autodelete" },
    ],
  },
  {
    id: "roles",
    label: "Role management",
    blurb: "Staff role assign, autorole, and identity restore.",
    include: [
      { plugin: "roles" },
      { plugin: "autorole" },
    ],
  },
  {
    id: "self_roles",
    label: "Self-serve roles",
    blurb: "Dashboard-managed role panels and self-serve role menus members can claim.",
    include: [{ plugin: "role_panels" }],
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
      { plugin: "clipping" },
      { plugin: "music" },
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
    blurb: "Reminders and live counters.",
    include: [
      { plugin: "reminders" },
      { plugin: "counters" },
    ],
  },
  {
    id: "custom",
    label: "Customization",
    blurb: "Custom commands built visually on the dashboard.",
    include: [
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
      { plugin: "booster_roles" },
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
    blurb: "Games and light server extras: a global and server economy, plane and airline trading cards, counting channels, giveaways, and images.",
    include: [{ plugin: "economy" }, { plugin: "counting" }, { plugin: "giveaways" }, { plugin: "images" }],
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

/** Display name/description per plugin — also used by the permission catalog to group Dreamliner Role grants by plugin. */
export const PLUGIN_DISPLAY: Record<string, EditorPluginMeta> = {
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
  impersonation: {
    key: "impersonation",
    name: "Impersonation Detection",
    description: "Flags members whose name or avatar closely matches a protected role holder or watchlist entry.",
  },
  raid_mesh: {
    key: "raid_mesh",
    name: "Raid Defense Mesh",
    description: "Link with other servers to share raid alerts, naming the accounts involved, when either side's raid detector trips.",
  },
  incident_response: {
    key: "incident_response",
    name: "Incident Response",
    description:
      "Correlates Automod, Raid, Impersonation, and Scam Protect signals (plus its own server-nuke detectors) into scored Incidents, with an opt-in escalating response per severity.",
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
  counting: {
    key: "counting",
    name: "Counting",
    description: "A fun counting game for your server. Members count up together one message at a time, with milestones to celebrate, custom messages and reactions, and full control over who's allowed to play.",
  },
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
  dream_commands: {
    key: "dream_commands",
    name: "Commands",
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
  giveaways: {
    key: "giveaways",
    name: "Giveaways",
    description:
      "Dashboard-built giveaways with button or reaction entry, role requirements, bonus entries, a winner claim window, and reusable templates. Staff can reroll, end, pause, or cancel from Discord.",
  },
  economy: {
    key: "economy",
    name: "Economy",
    description:
      "A global coin economy plus a customisable per-server currency, earned by chatting and daily claims, plus collectible plane and airline trading cards: buy packs with global coins, browse your hangar, and give cards to other members.",
  },
  images: {
    key: "images",
    name: "Images",
    description: "Random anime, Blåhaj, and animal images (cats, dogs, foxes, ducks, capybaras, birds) with /image, plus daily image drops into any channel.",
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
  clipping: {
    key: "clipping",
    name: "Clipping",
    description: "Record voice channel activity and export shareable clips with /clipping and /clip.",
  },
  music: {
    key: "music",
    name: "Music",
    description:
      "Play music from SoundCloud, Apple Music, Bandcamp, and more with queues, DJ roles, vote-skip, filters, and saved playlists.",
  },
  booster_roles: {
    key: "booster_roles",
    name: "Booster Roles",
    description: "Reward server boosters with different roles based on how long they've been boosting.",
  },
};

/**
 * Primary category for each guild-config plugin, aligned with `/help` categories.
 * Plugins that appear under multiple help sections (e.g. utility) get one home here.
 * Extras without slash-help entries are placed next to the closest help category.
 */
const PLUGIN_PRIMARY_CATEGORY: Record<string, string> = {
  infractions: "mod",
  slowmode: "mod",
  automod: "protect",
  impersonation: "protect",
  incident_response: "protect",
  raid_mesh: "protect",
  scam_protect: "protect",
  passport: "protect",
  persist: "protect",
  autodelete: "protect",
  roles: "roles",
  autorole: "roles",
  member_identity: "roles",
  reaction_roles: "self_roles",
  role_buttons: "self_roles",
  role_panels: "self_roles",
  locate_user: "info",
  name_history: "info",
  username_saver: "info",
  welcome_message: "engage",
  companion_channels: "engage",
  starboard: "engage",
  tts: "engage",
  clipping: "engage",
  music: "engage",
  tags: "respond",
  autoreplies: "respond",
  autothreads: "respond",
  autoreactions: "respond",
  translation: "respond",
  reminders: "schedule",
  counters: "schedule",
  dream_commands: "custom",
  utility: "tools",
  stats: "tools",
  booster_roles: "tools",
  bot_customisation: "tools",
  reviews: "feedback",
  suggestions: "feedback",
  tickets: "support",
  economy: "fun",
  counting: "fun",
  giveaways: "fun",
  images: "fun",
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
