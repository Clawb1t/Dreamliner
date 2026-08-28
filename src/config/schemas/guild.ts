import { z } from "zod";
import { LOG_EMOJI } from "../../core/logging/emojis.js";
import { zUtilityPluginSection } from "./utility.js";
import { zInfractionPluginSection } from "./infraction.js";
import { zAutorolePluginSection } from "./autorole.js";
import { zStarboardPluginSection } from "./starboard.js";
import { zReviewsPluginSection } from "./reviews.js";
import { zSuggestionsPluginSection } from "./suggestions.js";
import { zTicketsPluginSection } from "./tickets.js";
import { zScamProtectPluginSection } from "./scamProtect.js";
import { zPassportPluginSection } from "./passport.js";
import { zEconomyPluginSection } from "./economy.js";
import { zDefaultLanguage, zTranslationPluginSection } from "./translation.js";
import {
  zAdminPluginSection,
  zAutomodPluginSection,
  zAutodeletePluginSection,
  zAutoreactionsPluginSection,
  zAutorepliesPluginSection,
  zAutothreadsPluginSection,
  zCommandAliasesPluginSection,
  zCompanionChannelsPluginSection,
  zCountersPluginSection,
  zCustomEventsPluginSection,
  zBotCustomisationPluginSection,
  zDreamCommandsPluginSection,
  zLocateUserPluginSection,
  zMemberIdentityPluginSection,
  zNameHistoryPluginSection,
  zPersistPluginSection,
  zPingableRolesPluginSection,
  zPostPluginSection,
  zReactionRolesPluginSection,
  zRemindersPluginSection,
  zRoleButtonsPluginSection,
  zRoleManagerPluginSection,
  zRolePanelsPluginSection,
  zRolesPluginSection,
  zSelfGrantableRolesPluginSection,
  zSlowmodePluginSection,
  zStatsPluginSection,
  zTagsPluginSection,
  zUsernameSaverPluginSection,
  zWelcomeMessagePluginSection,
} from "./plugins.js";

export const zEmojisConfig = z.strictObject({
  success: z
    .string()
    .default("<:blurplecheck:1533947878668763278>")
    .describe("Emoji prefix for successful command responses."),
  error: z
    .string()
    .default("<:redcheck:1533947951481749504>")
    .describe("Emoji prefix for errors and permission denied."),
  neutral: z
    .string()
    .default("<:greycheck:1533948078615298148>")
    .describe("Emoji prefix for general information responses."),
  warning: z
    .string()
    .default("<:warning:1533948583995244734>")
    .describe("Emoji prefix for soft failures and advisories."),
  unchecked: z
    .string()
    .default("<:greycheck:1533948078615298148>")
    .describe("Emoji prefix for disabled or off states."),
});

export const zLogEmojisConfig = z.strictObject({
  action_emoji: z
    .string()
    .default(LOG_EMOJI.action)
    .describe("Fallback emoji for log events that don't fit any other category (e.g. message pin, DM failed)."),
  create_emoji: z.string().default(LOG_EMOJI.create).describe("Emoji for create events (channels, roles, threads, invites)."),
  delete_emoji: z.string().default(LOG_EMOJI.delete).describe("Emoji for delete events (channels, roles, messages, cases, clean)."),
  edit_emoji: z.string().default(LOG_EMOJI.edit).describe("Emoji for edit/update events (messages, channels, roles, nicknames)."),
  emoji_sticker_emoji: z
    .string()
    .default(LOG_EMOJI.emojiSticker)
    .describe("Emoji for emoji and sticker create/update/delete events."),
  join_emoji: z.string().default(LOG_EMOJI.join).describe("Emoji for member and voice join events."),
  leave_emoji: z.string().default(LOG_EMOJI.leave).describe("Emoji for member and voice leave events."),
  voice_emoji: z
    .string()
    .default(LOG_EMOJI.voice)
    .describe("Emoji for voice activity that isn't a plain join/leave (move, mute, deafen, stream, video)."),
  unban_emoji: z.string().default(LOG_EMOJI.unban).describe("Emoji for member unban and case unban events."),
  server_update_emoji: z
    .string()
    .default(LOG_EMOJI.serverUpdate)
    .describe("Emoji for server/config-level changes: guild settings, webhooks, dashboard config saves."),
  moderation_default_emoji: z
    .string()
    .default(LOG_EMOJI.modDefault)
    .describe("Emoji for non-punitive moderation bookkeeping: notes, case edits, passport checks, dashboard admin actions."),
  moderation_moderate_emoji: z
    .string()
    .default(LOG_EMOJI.modModerate)
    .describe("Emoji for corrective-but-not-account-ending actions: warns, mutes, timeouts, automod, censor."),
  moderation_severe_emoji: z
    .string()
    .default(LOG_EMOJI.modSevere)
    .describe("Emoji for account-ending or emergency actions: kicks, bans, raids, failed-verification kicks."),
});

export const zLoggingConfig = z
  .strictObject({
    events: z
      .record(z.boolean())
      .default({})
      .describe(
        "Per-event log toggles. Missing keys default to enabled. Keys match dashboard Logging toggles.",
      ),
    emojis: zLogEmojisConfig
      .default({})
      .describe("Custom emoji per log category, prefixed to every log card title in this server."),
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

export const zGuildConfig = z.strictObject({
  emojis: zEmojisConfig.default({}).describe("Response embed title emoji prefixes."),
  levels: z
    .record(z.coerce.number())
    .default({})
    .describe("Map role or user snowflake IDs to permission levels (higher = more access)."),
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
      "When true (default), anyone with Discord's Administrator permission (or the server owner) can use any bot command, regardless of levels/overrides — no configuration required. Disable to require explicit levels/overrides for admins too.",
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
  default_language: zDefaultLanguage,
  plugins: z
    .strictObject({
      utility: zUtilityPluginSection.optional(),
      infractions: zInfractionPluginSection.optional(),
      autorole: zAutorolePluginSection.optional(),
      member_identity: zMemberIdentityPluginSection.optional(),
      translation: zTranslationPluginSection.optional(),
      starboard: zStarboardPluginSection.optional(),
      automod: zAutomodPluginSection.optional(),
      scam_protect: zScamProtectPluginSection.optional(),
      passport: zPassportPluginSection.optional(),
      economy: zEconomyPluginSection.optional(),
      admin: zAdminPluginSection.optional(),
      persist: zPersistPluginSection.optional(),
      slowmode: zSlowmodePluginSection.optional(),
      roles: zRolesPluginSection.optional(),
      reaction_roles: zReactionRolesPluginSection.optional(),
      role_buttons: zRoleButtonsPluginSection.optional(),
      role_panels: zRolePanelsPluginSection.optional(),
      self_grantable_roles: zSelfGrantableRolesPluginSection.optional(),
      pingable_roles: zPingableRolesPluginSection.optional(),
      role_manager: zRoleManagerPluginSection.optional(),
      welcome_message: zWelcomeMessagePluginSection.optional(),
      tags: zTagsPluginSection.optional(),
      post: zPostPluginSection.optional(),
      autodelete: zAutodeletePluginSection.optional(),
      autoreactions: zAutoreactionsPluginSection.optional(),
      autoreplies: zAutorepliesPluginSection.optional(),
      autothreads: zAutothreadsPluginSection.optional(),
      reminders: zRemindersPluginSection.optional(),
      counters: zCountersPluginSection.optional(),
      companion_channels: zCompanionChannelsPluginSection.optional(),
      name_history: zNameHistoryPluginSection.optional(),
      username_saver: zUsernameSaverPluginSection.optional(),
      locate_user: zLocateUserPluginSection.optional(),
      stats: zStatsPluginSection.optional(),
      custom_events: zCustomEventsPluginSection.optional(),
      command_aliases: zCommandAliasesPluginSection.optional(),
      dream_commands: zDreamCommandsPluginSection.optional(),
      bot_customisation: zBotCustomisationPluginSection.optional(),
      reviews: zReviewsPluginSection.optional(),
      suggestions: zSuggestionsPluginSection.optional(),
      tickets: zTicketsPluginSection.optional(),
    })
    .default({}),
});

export type GuildConfig = z.infer<typeof zGuildConfig>;
export type EmojisConfig = z.infer<typeof zEmojisConfig>;
export type LogEmojisConfig = z.infer<typeof zLogEmojisConfig>;
export type LoggingConfig = z.infer<typeof zLoggingConfig>;
export type PublicStatsConfig = z.infer<typeof zPublicStatsConfig>;

export type PluginOverride = {
  level?: string;
  channel?: string;
  category?: string;
  user?: string;
  role?: string;
  config: Record<string, unknown>;
};
