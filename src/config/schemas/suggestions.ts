import { z } from "zod";
import { boolPerm, channelId } from "../schemaHelp.js";
import { zPluginOverride } from "./pluginSection.js";

const snowflakeList = (description: string) =>
  z.array(z.string()).default([]).describe(description);

export const SUGGESTION_MODES = ["review", "autoapprove"] as const;
export const SUGGESTION_DISPLAY_STATUSES = [
  "none",
  "considered",
  "progress",
  "implemented",
  "no",
] as const;

export const zSuggestionsConfig = z.strictObject({
  mode: z
    .enum(SUGGESTION_MODES)
    .default("review")
    .describe("`review` sends submissions to a staff queue first; `autoapprove` posts straight to the feed."),
  suggestions_channel_id: channelId("Public suggestions feed channel (required for posting)."),
  review_channel_id: channelId("Staff review queue channel (required in review mode)."),
  denied_channel_id: channelId("Optional channel for denied suggestion posts."),
  archive_channel_id: channelId("Optional archive channel when a suggestion is marked implemented."),
  log_channel_id: channelId("Optional channel for suggestion action logs."),
  allowed_suggest_roles: snowflakeList(
    "If non-empty, only these roles may submit suggestions.",
  ),
  blocked_suggest_roles: snowflakeList("Roles that cannot submit suggestions."),
  allowed_vote_roles: snowflakeList(
    "If non-empty, only these roles may vote on suggestions.",
  ),
  review_ping_role: z
    .string()
    .optional()
    .describe("Role to ping when a suggestion enters the review queue."),
  feed_ping_role: z
    .string()
    .optional()
    .describe("Role to ping when a suggestion is posted to the feed."),
  approved_role: z
    .string()
    .optional()
    .describe("Optional role granted to the author when their suggestion is approved."),
  implemented_role: z
    .string()
    .optional()
    .describe("Optional role granted when a suggestion is marked implemented."),
  anonymous: z
    .boolean()
    .default(false)
    .describe("Allow anonymous suggestions (staff still see the author)."),
  cooldown: z
    .string()
    .default("1h")
    .describe("Cooldown between submissions per user, e.g. `1h`. Empty string disables."),
  max_open: z
    .number()
    .int()
    .min(0)
    .default(5)
    .describe("Max open approved (non-implemented) suggestions per user. 0 = unlimited."),
  min_messages: z
    .number()
    .int()
    .min(0)
    .default(25)
    .describe("Minimum guild messages required before suggesting."),
  min_account_age: z
    .string()
    .default("7d")
    .describe("Minimum Discord account age, e.g. `7d`. Empty string disables."),
  min_member_age: z
    .string()
    .default("1d")
    .describe("Minimum time in this server, e.g. `1d`. Empty string disables."),
  command_channels: snowflakeList(
    "If non-empty, /suggest may only be used in these channels.",
  ),
  ignored_channels: snowflakeList("Channels where suggestion commands are refused."),
  allow_attachments: z.boolean().default(true).describe("Allow image attachments on suggestions."),
  max_length: z.number().int().min(1).max(2000).default(1000).describe("Max suggestion text length."),
  min_length: z.number().int().min(1).default(15).describe("Min suggestion text length."),
  voting_enabled: z.boolean().default(true).describe("Show vote buttons on approved suggestions."),
  upvote_label: z.string().default("Upvote").describe("Upvote button label."),
  midvote_label: z.string().default("Neutral").describe("Mid vote button label."),
  downvote_label: z.string().default("Downvote").describe("Downvote button label."),
  upvote_emoji: z.string().default("👍").describe("Emoji shown on the upvote button."),
  midvote_emoji: z.string().default("😐").describe("Emoji shown on the mid / neutral vote button."),
  downvote_emoji: z.string().default("👎").describe("Emoji shown on the downvote button."),
  mid_vote_enabled: z.boolean().default(true).describe("Include a neutral / mid vote button."),
  allow_self_vote: z.boolean().default(false).describe("Allow authors to vote on their own suggestion."),
  show_vote_count: z.boolean().default(true).describe("Show live vote totals on the vote buttons."),
  color_change_threshold: z
    .number()
    .int()
    .min(0)
    .default(10)
    .describe("Net upvotes required to change embed color. 0 = disabled."),
  color_change_color: z
    .number()
    .int()
    .min(0)
    .max(0xffffff)
    .default(0x57f287)
    .describe("Embed color when net upvotes reach the threshold."),
  notify_author: z
    .boolean()
    .default(true)
    .describe("DM the author on approve, deny, mark, and comment when possible."),
  follow_on_upvote: z
    .boolean()
    .default(true)
    .describe("Auto-follow a suggestion when a member upvotes it."),
  can_suggest: boolPerm("submit suggestions"),
  can_vote: boolPerm("vote on suggestions"),
  can_follow: boolPerm("follow suggestions for updates"),
  can_info: boolPerm("view suggestion info"),
  can_top: boolPerm("view top suggestions"),
  can_approve: boolPerm("approve suggestions"),
  can_deny: boolPerm("deny suggestions"),
  can_mark: boolPerm("mark suggestion status"),
  can_comment: boolPerm("comment on suggestions"),
  can_delete: boolPerm("delete suggestions"),
  can_block: boolPerm("block users from suggesting"),
  can_manage: boolPerm("manage the suggestion queue and mass actions"),
});

export const zSuggestionsPluginSection = z.strictObject({
  enabled: z.boolean().optional().describe("Turn suggestions on or off for this server."),
  config: zSuggestionsConfig.partial().optional(),
  overrides: z.array(zPluginOverride).optional(),
  replaceDefaultOverrides: z
    .boolean()
    .optional()
    .describe("When true, ignore Dreamliner's built-in default level grants for this plugin."),
});

export type SuggestionsConfig = z.infer<typeof zSuggestionsConfig>;
export type SuggestionMode = (typeof SUGGESTION_MODES)[number];
export type SuggestionDisplayStatus = (typeof SUGGESTION_DISPLAY_STATUSES)[number];
