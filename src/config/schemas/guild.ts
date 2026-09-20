import { z } from "zod";
import { LOG_EMOJI } from "../../core/logging/emojis.js";
import { zUtilityPluginSection } from "./utility.js";
import { zInfractionPluginSection } from "./infraction.js";
import { zAutorolePluginSection } from "./autorole.js";
import { zStarboardPluginSection } from "./starboard.js";
import { zReviewsPluginSection } from "./reviews.js";
import { zSuggestionsPluginSection } from "./suggestions.js";
import { zTicketsPluginSection } from "./tickets.js";
import { zGiveawaysPluginSection } from "./giveaways.js";
import { zScamProtectPluginSection } from "./scamProtect.js";
import { zPassportPluginSection } from "./passport.js";
import { zIncidentResponsePluginSection } from "./incidentResponse.js";
import { zEconomyPluginSection } from "./economy.js";
import { zMusicPluginSection } from "./music.js";
import { zDefaultLanguage, zTranslationPluginSection } from "./translation.js";
import { zSocialPluginSection } from "./social.js";
import {
  zAutomodPluginSection,
  zImpersonationPluginSection,
  zRaidMeshPluginSection,
  zAutodeletePluginSection,
  zBoosterRolesPluginSection,
  zAutoreactionsPluginSection,
  zAutorepliesPluginSection,
  zAutothreadsPluginSection,
  zCompanionChannelsPluginSection,
  zCountersPluginSection,
  zCountingPluginSection,
  zBotCustomisationPluginSection,
  zDreamCommandsPluginSection,
  zLocateUserPluginSection,
  zMemberIdentityPluginSection,
  zNameHistoryPluginSection,
  zPersistPluginSection,
  zReactionRolesPluginSection,
  zRemindersPluginSection,
  zRoleButtonsPluginSection,
  zRolePanelsPluginSection,
  zRolesPluginSection,
  zSlowmodePluginSection,
  zStatsPluginSection,
  zTagsPluginSection,
  zTtsPluginSection,
  zClippingPluginSection,
  zUsernameSaverPluginSection,
  zWelcomeMessagePluginSection,
} from "./plugins.js";

// Fixed, not admin-configurable (dashboard/YAML can no longer change these) — every server sees
// the same icon set. `z.literal(...)` means any other stored/uploaded value simply fails
// validation and the existing config-repair mechanism resets it back to the one true default, so
// there's no live "ability to edit" left anywhere (dashboard, /config upload, or a raw PUT).
export const zEmojisConfig = z.strictObject({
  success: z
    .literal("<:icons_Correct:1544417199798886530>")
    .default("<:icons_Correct:1544417199798886530>")
    .describe("Emoji prefix for successful command responses. Fixed, not configurable."),
  error: z
    .literal("<:icons_Wrong:1544417460638457937>")
    .default("<:icons_Wrong:1544417460638457937>")
    .describe("Emoji prefix for errors and permission denied. Fixed, not configurable."),
  neutral: z
    .literal("<:icons_generalinfo:1544417795335389254>")
    .default("<:icons_generalinfo:1544417795335389254>")
    .describe("Emoji prefix for general information responses. Fixed, not configurable."),
  warning: z
    .literal("<:icons_exclamation:1544417272376852490>")
    .default("<:icons_exclamation:1544417272376852490>")
    .describe("Emoji prefix for soft failures and advisories. Fixed, not configurable."),
  unchecked: z
    .literal("<:icons_disable:1544417870652379277>")
    .default("<:icons_disable:1544417870652379277>")
    .describe("Emoji prefix for disabled or off states. Fixed, not configurable."),
});

export const zLogEmojisConfig = z.strictObject({
  action_emoji: z
    .literal(LOG_EMOJI.action)
    .default(LOG_EMOJI.action)
    .describe("Fallback emoji for log events that don't fit any other category (e.g. message pin, DM failed). Fixed, not configurable."),
  create_emoji: z
    .literal(LOG_EMOJI.create)
    .default(LOG_EMOJI.create)
    .describe("Emoji for create events (channels, roles, threads, invites). Fixed, not configurable."),
  delete_emoji: z
    .literal(LOG_EMOJI.delete)
    .default(LOG_EMOJI.delete)
    .describe("Emoji for delete events (channels, roles, messages, cases, clean). Fixed, not configurable."),
  edit_emoji: z
    .literal(LOG_EMOJI.edit)
    .default(LOG_EMOJI.edit)
    .describe("Emoji for edit/update events (messages, channels, roles, nicknames). Fixed, not configurable."),
  emoji_sticker_emoji: z
    .literal(LOG_EMOJI.emojiSticker)
    .default(LOG_EMOJI.emojiSticker)
    .describe("Emoji for emoji and sticker create/update/delete events. Fixed, not configurable."),
  join_emoji: z
    .literal(LOG_EMOJI.join)
    .default(LOG_EMOJI.join)
    .describe("Emoji for member and voice join events. Fixed, not configurable."),
  leave_emoji: z
    .literal(LOG_EMOJI.leave)
    .default(LOG_EMOJI.leave)
    .describe("Emoji for member and voice leave events. Fixed, not configurable."),
  voice_emoji: z
    .literal(LOG_EMOJI.voice)
    .default(LOG_EMOJI.voice)
    .describe("Emoji for voice activity that isn't a plain join/leave (move, mute, deafen, stream, video). Fixed, not configurable."),
  unban_emoji: z
    .literal(LOG_EMOJI.unban)
    .default(LOG_EMOJI.unban)
    .describe("Emoji for member unban and case unban events. Fixed, not configurable."),
  server_update_emoji: z
    .literal(LOG_EMOJI.serverUpdate)
    .default(LOG_EMOJI.serverUpdate)
    .describe("Emoji for server/config-level changes: guild settings, webhooks, dashboard config saves. Fixed, not configurable."),
  moderation_default_emoji: z
    .literal(LOG_EMOJI.modDefault)
    .default(LOG_EMOJI.modDefault)
    .describe("Emoji for non-punitive moderation bookkeeping: notes, case edits, passport checks, dashboard admin actions. Fixed, not configurable."),
  moderation_moderate_emoji: z
    .literal(LOG_EMOJI.modModerate)
    .default(LOG_EMOJI.modModerate)
    .describe("Emoji for corrective-but-not-account-ending actions: warns, mutes, timeouts, automod, censor. Fixed, not configurable."),
  moderation_severe_emoji: z
    .literal(LOG_EMOJI.modSevere)
    .default(LOG_EMOJI.modSevere)
    .describe("Emoji for account-ending or emergency actions: kicks, bans, raids, failed-verification kicks. Fixed, not configurable."),
});

export const zLoggingConfig = z
  .strictObject({
    events: z
      .record(z.boolean())
      .default({})
      .describe(
        "Per-event log toggles. Missing keys default to enabled. Keys match dashboard Logging toggles.",
      ),
    channels: z
      .record(z.string())
      .default({})
      .describe(
        "Per-event channel overrides, keyed by the same event keys as `events`. Missing keys fall back to a plugin's own log channel (if any), then the moderation/server default channel.",
      ),
    emojis: zLogEmojisConfig
      .default({})
      .describe("Fixed emoji per log category, prefixed to every log card title. Not configurable."),
  })
  .default({});

const serverAccentColor = z
  .number()
  .int()
  .min(0)
  .max(0xffffff)
  .default(0x5662f5)
  .describe(
    "Accent color for this server's public pages (server home, leaderboard, and public stats). Decimal 0–16777215.",
  );

export const zPublicStatsConfig = z
  .strictObject({
    overview: z
      .boolean()
      .default(false)
      .describe("Publish the Overview tab on the public server stats page."),
    activity: z
      .boolean()
      .default(false)
      .describe("Publish the Activity tab on the public server stats page."),
    membership: z
      .boolean()
      .default(false)
      .describe("Publish the Membership tab on the public server stats page."),
    engagement: z
      .boolean()
      .default(false)
      .describe("Publish the Engagement tab on the public server stats page."),
    patterns: z
      .boolean()
      .default(false)
      .describe("Publish the Patterns tab on the public server stats page."),
    leaders: z
      .boolean()
      .default(false)
      .describe(
        "Publish the Leaderboards tab (messagers, channels, commands) on the public server stats page. The dedicated public messagers leaderboard page is always available.",
      ),
    table: z
      .boolean()
      .default(false)
      .describe("Publish the Daily table tab on the public server stats page."),
  })
  .default({});

export const zServerPageLink = z.strictObject({
  label: z.string().min(1).max(40).describe("Button label."),
  url: z.string().min(1).max(300).describe("https URL this button opens."),
});

export const zPublicServerPageConfig = z
  .strictObject({
    description: z
      .string()
      .max(300)
      .default("")
      .describe("A short description of the server, shown on its public Dreamliner home page."),
    show_description: z
      .boolean()
      .default(true)
      .describe("Show the description widget when a description is set below."),
    invite_url: z
      .string()
      .max(300)
      .default("")
      .describe(
        "A permanent invite link (e.g. https://discord.gg/yourcode). Adds a Join server button to the public home page.",
      ),
    show_voice_activity: z
      .boolean()
      .default(false)
      .describe("Show who's currently in voice channels on the public home page."),
    show_active_channels: z
      .boolean()
      .default(false)
      .describe("Show the most active text channels from the last 24 hours on the public home page."),
    show_boost_status: z
      .boolean()
      .default(false)
      .describe("Show this server's boost tier and count on the public home page."),
    show_emojis: z
      .boolean()
      .default(false)
      .describe("Show a gallery of this server's custom emojis on the public home page."),
    show_leaderboard: z
      .boolean()
      .default(false)
      .describe("Show a top-5 messagers leaderboard preview on the public home page."),
    custom_links: z
      .array(zServerPageLink)
      .max(5)
      .default([])
      .describe("Custom link buttons on the public home page, like a website, rules, or socials."),
  })
  .default({});

export const zGuildConfig = z.strictObject({
  emojis: zEmojisConfig.default({}).describe("Response embed title emoji prefixes."),
  /** @deprecated Use moderation_log_channel_id */
  log_channel_id: z
    .string()
    .optional()
    .describe("Deprecated. Use moderation_log_channel_id instead."),
  server_log_channel_id: z
    .string()
    .optional()
    .describe("Channel for joins, leaves, edits, deletes, voice, and role/nickname changes."),
  moderation_log_channel_id: z
    .string()
    .optional()
    .describe("Channel for infractions, automod, clean, voice mod, and case updates."),
  logging: zLoggingConfig.describe("Log event toggles for Discord channels and the dashboard Logs page."),
  ephemeral_responses: z
    .boolean()
    .default(false)
    .describe("When true, command replies are only visible to the user who ran the command."),
  admin_bypass: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), anyone with Discord's Administrator permission (or the server owner) can use any bot command, regardless of Dreamliner Role assignment — no configuration required. Disable to require explicit role assignment for admins too.",
    ),
  server_accent_color: serverAccentColor,
  leaderboard_override_user_accents: z
    .boolean()
    .default(false)
    .describe(
      "When true, ignore personal user accent colors on this server's public leaderboard and use the server accent instead.",
    ),
  public_stats: zPublicStatsConfig.describe(
    "Which Stats tabs are visible on the public /server/:id/stats page. The messagers leaderboard page is always public.",
  ),
  server_page: zPublicServerPageConfig.describe(
    "Description, widgets, and custom links shown on the public /server/:id home page.",
  ),
  default_language: zDefaultLanguage,
  content_retention_days: z
    .union([z.literal(1), z.literal(7), z.literal(14), z.literal(30)])
    .default(30)
    .describe(
      "How long message content (not counts or timestamps) stays retained: 1, 7, 14, or 30 days. Evidence mode captures and the moderation edit/delete log are kept 42 days regardless.",
    ),
  plugins: z
    .strictObject({
      utility: zUtilityPluginSection.default({}),
      infractions: zInfractionPluginSection.default({}),
      autorole: zAutorolePluginSection.default({}),
      member_identity: zMemberIdentityPluginSection.default({}),
      translation: zTranslationPluginSection.default({}),
      starboard: zStarboardPluginSection.default({}),
      automod: zAutomodPluginSection.default({}),
      impersonation: zImpersonationPluginSection.default({}),
      incident_response: zIncidentResponsePluginSection.default({}),
      raid_mesh: zRaidMeshPluginSection.default({}),
      scam_protect: zScamProtectPluginSection.default({}),
      passport: zPassportPluginSection.default({}),
      economy: zEconomyPluginSection.default({}),
      persist: zPersistPluginSection.default({}),
      slowmode: zSlowmodePluginSection.default({}),
      roles: zRolesPluginSection.default({}),
      reaction_roles: zReactionRolesPluginSection.default({}),
      role_buttons: zRoleButtonsPluginSection.default({}),
      role_panels: zRolePanelsPluginSection.default({}),
      welcome_message: zWelcomeMessagePluginSection.default({}),
      tags: zTagsPluginSection.default({}),
      autodelete: zAutodeletePluginSection.default({}),
      booster_roles: zBoosterRolesPluginSection.default({}),
      autoreactions: zAutoreactionsPluginSection.default({}),
      autoreplies: zAutorepliesPluginSection.default({}),
      autothreads: zAutothreadsPluginSection.default({}),
      reminders: zRemindersPluginSection.default({}),
      counters: zCountersPluginSection.default({}),
      counting: zCountingPluginSection.default({}),
      companion_channels: zCompanionChannelsPluginSection.default({}),
      tts: zTtsPluginSection.default({}),
      music: zMusicPluginSection.default({}),
      clipping: zClippingPluginSection.default({}),
      name_history: zNameHistoryPluginSection.default({}),
      username_saver: zUsernameSaverPluginSection.default({}),
      locate_user: zLocateUserPluginSection.default({}),
      stats: zStatsPluginSection.default({}),
      dream_commands: zDreamCommandsPluginSection.default({}),
      bot_customisation: zBotCustomisationPluginSection.default({}),
      reviews: zReviewsPluginSection.default({}),
      suggestions: zSuggestionsPluginSection.default({}),
      tickets: zTicketsPluginSection.default({}),
      giveaways: zGiveawaysPluginSection.default({}),
      social: zSocialPluginSection.default({}),
    })
    .default({}),
});

export type GuildConfig = z.infer<typeof zGuildConfig>;
export type EmojisConfig = z.infer<typeof zEmojisConfig>;
export type LogEmojisConfig = z.infer<typeof zLogEmojisConfig>;
export type LoggingConfig = z.infer<typeof zLoggingConfig>;
export type PublicStatsConfig = z.infer<typeof zPublicStatsConfig>;
