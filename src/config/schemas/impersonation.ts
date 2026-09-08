import { z } from "zod";
import { boolPerm, channelId } from "../schemaHelp.js";

export const IMPERSONATION_AUTO_ACTIONS = ["none", "timeout", "kick", "ban"] as const;
export type ImpersonationAutoAction = (typeof IMPERSONATION_AUTO_ACTIONS)[number];

export const IMPERSONATION_COMPARE_SCOPES = ["protected_only", "everyone"] as const;
export type ImpersonationCompareScope = (typeof IMPERSONATION_COMPARE_SCOPES)[number];

export const zImpersonationConfig = z.strictObject({
  ignored_roles: z
    .array(z.string())
    .default([])
    .describe("Members with any of these roles are never flagged as impersonators (e.g. a bot-tag role)."),
  protected_roles: z
    .array(z.string())
    .default([])
    .describe(
      "Anyone whose name or avatar closely matches a current holder of one of these roles gets flagged — the easiest way to protect staff without hand-picking every mod.",
    ),
  compare_scope: z
    .enum(IMPERSONATION_COMPARE_SCOPES)
    .default("protected_only")
    .describe(
      "Who counts as a protected identity to compare against. 'protected_only' checks against Protected roles + the watchlist (fast, low noise, recommended). 'everyone' also compares every member against every other member — thorough, but slow and noisier on large servers.",
    ),
  check_on_join: z.boolean().default(true).describe("Check a member's identity the moment they join."),
  check_username: z.boolean().default(true).describe("Check when someone changes their Discord username."),
  check_display_name: z.boolean().default(true).describe("Check when someone changes their global display name."),
  check_nickname: z.boolean().default(true).describe("Check when someone changes their nickname in this server."),
  check_avatar: z.boolean().default(true).describe("Check when someone changes their avatar (server or global)."),
  name_similarity_threshold: z
    .number()
    .int()
    .min(50)
    .max(100)
    .default(82)
    .describe("How similar a name has to be (0-100%) to count as a match. Lower catches more, but risks false positives."),
  avatar_max_distance: z
    .number()
    .int()
    .min(0)
    .max(64)
    .default(8)
    .describe("How close an avatar's fingerprint must be (0 = identical, 64 = unrelated) to count as a match."),
  log_channel_id: channelId("Channel Impersonation Detection posts alerts to. Falls back to the server moderation log channel if empty."),
  notify_staff: z.boolean().default(true).describe("Post an alert to the log channel when a likely impersonation is detected."),
  dm_flagged_member: z
    .boolean()
    .default(false)
    .describe("DM the flagged member letting them know their profile was flagged (off by default — often not worth tipping them off)."),
  auto_action: z
    .enum(IMPERSONATION_AUTO_ACTIONS)
    .default("none")
    .describe("Automatic action to take against a flagged member. Leave as 'none' to just alert staff and decide by hand."),
  auto_action_duration_ms: z
    .number()
    .int()
    .min(60_000)
    .optional()
    .describe("Timeout duration when auto_action is 'timeout'."),
  can_status: boolPerm("review Impersonation Detection alerts"),
});

export type ImpersonationConfig = z.infer<typeof zImpersonationConfig>;
