import { z } from "zod";
import { boolPerm, channelId } from "../schemaHelp.js";

const snowflakeList = (description: string) =>
  z.array(z.string()).default([]).describe(description);

export const zReviewsConfig = z.strictObject({
  review_channel_id: channelId("Channel where public review embeds are posted."),
  min_messages: z
    .number()
    .int()
    .min(0)
    .default(50)
    .describe("Minimum guild messages (tracked by Dreamliner) required before reviewing."),
  min_account_age: z
    .string()
    .default("7d")
    .describe("Minimum Discord account age, e.g. `7d` or `30d`. Empty string disables."),
  min_member_age: z
    .string()
    .default("3d")
    .describe("Minimum time in this server before reviewing, e.g. `1d` or `1w`. Empty string disables."),
  cooldown: z
    .string()
    .default("7d")
    .describe("Cooldown between reviews (or edits) per user, e.g. `1d`. Empty string disables."),
  allow_edit: z
    .boolean()
    .default(true)
    .describe("When true, members can update their existing review instead of submitting once."),
  allowed_roles: snowflakeList(
    "If non-empty, only members with one of these roles may submit reviews.",
  ),
  blocked_roles: snowflakeList("Members with any of these roles cannot submit reviews."),
  ignored_channels: snowflakeList("Channel IDs where /review is refused."),
  anonymous: z
    .boolean()
    .default(false)
    .describe("When true, public embeds hide the author. Staff and the dashboard still see them."),
  require_text: z.boolean().default(true).describe("Require a written comment with the rating."),
  min_text_length: z.number().int().min(0).default(20).describe("Minimum comment length."),
  max_text_length: z.number().int().min(1).max(2000).default(1000).describe("Maximum comment length."),
  min_rating: z.number().int().min(1).max(5).default(1).describe("Lowest allowed star rating."),
  max_rating: z.number().int().min(1).max(5).default(5).describe("Highest allowed star rating."),
  can_review: boolPerm("submit a server review"),
  can_list: boolPerm("list reviews"),
  can_delete: boolPerm("delete reviews"),
  can_manage: boolPerm("manage reviews (staff)"),
});

export const zReviewsPluginSection = z.strictObject({
  enabled: z.boolean().optional().describe("Turn reviews on or off for this server."),
  config: zReviewsConfig.partial().optional(),
});

export type ReviewsConfig = z.infer<typeof zReviewsConfig>;
