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
import { zAnimePluginSection } from "./anime.js";
import { zDefaultLanguage, zTranslationPluginSection } from "./translation.js";
import { zSocialPluginSection } from "./social.js";
import {
  zAutomodPluginSection,
  zAutodeletePluginSection,
  zAutoreactionsPluginSection,
  zAutorepliesPluginSection,
  zAutothreadsPluginSection,
  zCompanionChannelsPluginSection,
  zCountersPluginSection,
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
  zSelfGrantableRolesPluginSection,
  zSlowmodePluginSection,
  zStatsPluginSection,
  zTagsPluginSection,
  zTtsPluginSection,
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
      anime: zAnimePluginSection.optional(),
      persist: zPersistPluginSection.optional(),
      slowmode: zSlowmodePluginSection.optional(),
      roles: zRolesPluginSection.optional(),
      reaction_roles: zReactionRolesPluginSection.optional(),
      role_buttons: zRoleButtonsPluginSection.optional(),
      role_panels: zRolePanelsPluginSection.optional(),
      self_grantable_roles: zSelfGrantableRolesPluginSection.optional(),
      welcome_message: zWelcomeMessagePluginSection.optional(),
      tags: zTagsPluginSection.optional(),
      autodelete: zAutodeletePluginSection.optional(),
      autoreactions: zAutoreactionsPluginSection.optional(),
      autoreplies: zAutorepliesPluginSection.optional(),
      autothreads: zAutothreadsPluginSection.optional(),
      reminders: zRemindersPluginSection.optional(),
      counters: zCountersPluginSection.optional(),
      companion_channels: zCompanionChannelsPluginSection.optional(),
      tts: zTtsPluginSection.optional(),
      name_history: zNameHistoryPluginSection.optional(),
      username_saver: zUsernameSaverPluginSection.optional(),
      locate_user: zLocateUserPluginSection.optional(),
      stats: zStatsPluginSection.optional(),
      dream_commands: zDreamCommandsPluginSection.optional(),
      bot_customisation: zBotCustomisationPluginSection.optional(),
      reviews: zReviewsPluginSection.optional(),
      suggestions: zSuggestionsPluginSection.optional(),
      tickets: zTicketsPluginSection.optional(),
      social: zSocialPluginSection.optional(),
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
