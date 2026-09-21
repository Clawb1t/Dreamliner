import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";

/**
 * Watchdog's tier cutoffs, per-signal point values, and recency-decay curve parameters, all
 * guild-configurable. Every default below MUST match the constant it replaces in
 * `src/bridge/watchdogScoring.ts` exactly, so a guild that never touches this section sees no
 * score change purely from this config existing.
 */
export const zWatchdogTiersConfig = z.strictObject({
  watch: z.number().int().min(0).max(100).default(25).describe("Score needed to reach the Watch tier."),
  elevated: z.number().int().min(0).max(100).default(50).describe("Score needed to reach the Elevated tier."),
  critical: z.number().int().min(0).max(100).default(75).describe("Score needed to reach the Critical tier."),
});

export const zWatchdogWeightsConfig = z.strictObject({
  account_age_new: z.number().int().min(0).default(30).describe("Points for an account created within the last 24 hours."),
  account_age_week: z.number().int().min(0).default(22).describe("Points for an account less than a week old."),
  account_age_month: z.number().int().min(0).default(12).describe("Points for an account less than a month old."),
  account_age_6_months: z.number().int().min(0).default(5).describe("Points for an account less than 6 months old."),
  join_gap_hour: z.number().int().min(0).default(20).describe("Points for joining this server within an hour of account creation."),
  join_gap_day: z.number().int().min(0).default(10).describe("Points for joining this server within a day of account creation."),
  default_avatar: z.number().int().min(0).default(6).describe("Points for still using the default Discord avatar."),
  suspicious_username: z.number().int().min(0).default(8).describe("Points for a username matching a bulk-generated handle pattern."),
  no_extra_roles: z.number().int().min(0).default(5).describe("Points for having no roles beyond the default @everyone."),
  automod_hit_per_hit: z.number().int().min(0).default(12).describe("Points per automod hit in the last 30 days, before decay and the cap below."),
  automod_hit_cap: z.number().int().min(0).default(35).describe("Maximum points the automod-hits signal can contribute."),
  mod_case_active: z.number().int().min(0).default(18).describe("Points per active moderation case, before decay and the cap below."),
  mod_case_past: z.number().int().min(0).default(6).describe("Points per resolved moderation case, before decay and the cap below."),
  mod_case_cap: z.number().int().min(0).default(40).describe("Maximum points the moderation-case signal can contribute."),
  join_burst_heavy: z.number().int().min(0).default(25).describe("Points for sending 15+ messages within 5 minutes of joining."),
  join_burst_moderate: z.number().int().min(0).default(12).describe("Points for sending 6+ messages within 5 minutes of joining."),
  duplicate_content_heavy: z.number().int().min(0).default(22).describe("Points for posting identical content across 3+ channels."),
  duplicate_content_moderate: z.number().int().min(0).default(12).describe("Points for posting identical content across 2+ channels."),
  scam_keyword_hit: z.number().int().min(0).default(28).describe("Points for scam-style phrasing in recent messages."),
  profanity_repeated: z.number().int().min(0).default(15).describe("Points for 3+ distinct profane/slur words in recent messages."),
  profanity_single: z.number().int().min(0).default(6).describe("Points for any profanity in recent messages."),
  low_global_standing: z.number().int().min(0).default(10).describe("Points for a very new account with almost no message history anywhere on the platform."),
  open_incident: z.number().int().min(0).default(18).describe("Points for currently having an open Incident Response case."),
  convergence_2_categories: z.number().int().min(0).default(15).describe("Bonus points when signals from 2 distinct risk categories (identity, history, behavior, standing) both fire."),
  convergence_3_plus_categories: z.number().int().min(0).default(20).describe("Bonus points when signals from 3 or more distinct risk categories all fire."),
});

export const zWatchdogDecayConfig = z.strictObject({
  mod_case_full_weight_days: z.number().int().min(0).default(30).describe("Moderation cases within this many days count at full weight."),
  mod_case_floor_days: z.number().int().min(0).default(165).describe("Moderation cases at or beyond this many days old taper down to the floor weight below."),
  mod_case_floor_percent: z.number().int().min(0).max(100).default(20).describe("Minimum percent weight a very old moderation case still counts for."),
  automod_hit_full_weight_days: z.number().int().min(0).default(7).describe("Automod hits within this many days count at full weight."),
  automod_hit_floor_days: z.number().int().min(0).default(30).describe("Automod hits at or beyond this many days old taper down to the floor weight below (the underlying table is pruned at 30 days anyway)."),
  automod_hit_floor_percent: z.number().int().min(0).max(100).default(40).describe("Minimum percent weight an automod hit nearing 30 days old still counts for."),
});

export const zWatchdogConfig = z.strictObject({
  tiers: zWatchdogTiersConfig.default({}).describe("Score thresholds for each Watchdog risk tier."),
  weights: zWatchdogWeightsConfig.default({}).describe("Point value of each Watchdog risk signal."),
  decay: zWatchdogDecayConfig.default({}).describe("How quickly moderation history loses weight as it ages."),
});

export type WatchdogTiersConfig = z.infer<typeof zWatchdogTiersConfig>;
export type WatchdogWeightsConfig = z.infer<typeof zWatchdogWeightsConfig>;
export type WatchdogDecayConfig = z.infer<typeof zWatchdogDecayConfig>;
export type WatchdogConfig = z.infer<typeof zWatchdogConfig>;

export const zUtilityConfig = z.strictObject({
  jumbo_size: z
    .number()
    .int()
    .min(16)
    .max(2048)
    .default(128)
    .describe("Pixel size used by /jumbo when enlarging emoji."),
  autojoin_threads: z
    .boolean()
    .default(true)
    .describe("Automatically join threads when Dreamliner is mentioned or used in them."),
  expand_message_links: z
    .boolean()
    .default(true)
    .describe(
      "When a Discord message link is pasted in chat, repost that message (content and attachments) via webhook with the original author's name and avatar.",
    ),
  expand_message_links_max_length: z
    .number()
    .int()
    .min(0)
    .max(4000)
    .default(0)
    .describe(
      "Skip quoting a linked message if its content is longer than this many characters (0 = no limit).",
    ),
  info_on_single_result: z
    .boolean()
    .default(true)
    .describe("When a search returns exactly one result, show the full info view automatically."),
  global_watchdog_action: z
    .enum(["off", "alert", "kick", "ban"])
    .default("off")
    .describe(
      "What to do when a member on Dreamliner's platform-wide Global Watchdog list (confirmed bad actors, added by platform superusers) joins this server: off, alert staff in the mod log, kick, or ban. Off by default.",
    ),
  watchdog: zWatchdogConfig
    .default({})
    .describe("Tier cutoffs, per-signal point values, and recency-decay curve for the Watchdog risk score."),
  can_search: boolPerm("use /search"),
  can_clean: boolPerm("use /clean"),
  can_userinfo: boolPerm("use user info commands"),
  can_server: boolPerm("use server info"),
  can_channelinfo: boolPerm("use channel info"),
  can_messageinfo: boolPerm("use message info"),
  can_inviteinfo: boolPerm("use invite info"),
  can_roleinfo: boolPerm("use role info"),
  can_emojiinfo: boolPerm("use emoji info"),
  can_snowflake: boolPerm("look up snowflake IDs"),
  can_roles: boolPerm("use role listing utilities"),
  can_level: boolPerm("check permission levels"),
  can_watchdog: boolPerm("run /watchdog risk checks on a member"),
  can_context: boolPerm("use context utilities"),
  can_source: boolPerm("view message source"),
  can_nickname: boolPerm("change nicknames"),
  can_vcmove: boolPerm("move members in voice"),
  can_vckick: boolPerm("disconnect members from voice"),
  can_ping: boolPerm("use ping utilities"),
  can_about: boolPerm("use /about"),
  can_help: boolPerm("use /help"),
  can_reload_guild: boolPerm("reload the guild config from the database"),
  can_avatar: boolPerm("use avatar commands"),
  can_jumbo: boolPerm("use /jumbo"),
  can_stealemoji: boolPerm("use /stealemoji to copy custom emojis into this server"),
  can_info: boolPerm("use generic /info"),
  can_time: boolPerm("use time utilities"),
  can_convert_gif: boolPerm("use the Convert to GIF message context command"),
  can_create_sticker: boolPerm("use the Create Sticker message context command"),
  can_create_emoji: boolPerm("use the Create Emoji message context command"),
  can_snipe: boolPerm("use /snipe to bring back the most recently deleted message in a channel"),
  can_quote_to_discofy: boolPerm("use the Quote to Discofy message context command"),
  can_listening_to: boolPerm("use the Listening to user context command"),
  can_discofy: boolPerm("use /discofy to pull a random or searched Discofy avatar/banner"),
  can_one: boolPerm("check Dreamliner One status and see the subscribe button for this server"),
});

export type UtilityConfig = z.infer<typeof zUtilityConfig>;

// The only plugin enabled out of the box — everything else is opt-in from the dashboard.
export const zUtilityPluginSection = zPluginSection(zUtilityConfig.shape, true);

export type UtilityPluginSection = z.infer<typeof zUtilityPluginSection>;
