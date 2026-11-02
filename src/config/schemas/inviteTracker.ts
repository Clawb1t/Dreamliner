import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";
import { zWelcomeRichMessage } from "./welcome.js";

/** When a join counts towards the inviter: straight away, or once the member passes Passport. */
export const INVITE_COUNT_ON = ["join", "verified"] as const;
/** What a member joining the server again does: count normally, count as fake, or not count at all. */
export const INVITE_REJOIN_POLICIES = ["count", "fake", "ignore"] as const;
/** A join whose member left within `quick_leave_minutes` counts as a normal leave, or as fake. */
export const INVITE_QUICK_LEAVE_AS = ["left", "fake"] as const;
/** What a detected join burst does: alert staff, delete the invite it came through, or pause every invite. */
export const INVITE_RAID_ACTIONS = ["alert", "delete_invite", "pause_all"] as const;

export const DEFAULT_INVITE_JOIN_TEXT = "{user} joined, invited by **{inviter_name}** ({invites} invites)";
export const DEFAULT_INVITE_UNKNOWN_TEXT = "{user} joined via {join_source}";
export const DEFAULT_INVITE_LEAVE_TEXT = "{user_name} left. They were invited by **{inviter_name}** ({invites} invites)";

const zInviteMessage = (content: string) => zWelcomeRichMessage.default({ content });

/** A channel ID that's null (not just missing) when unset, matching what the dashboard sends. */
const nullableChannelId = (help: string) =>
  z
    .string()
    .nullable()
    .default(null)
    .describe(`${help} Paste a Discord channel ID (Developer Mode → right-click channel → Copy Channel ID).`);

/** A `can_*` flag that defaults on, for read-only lookups every member should have. */
const boolPermOn = (action: string) => z.boolean().default(true).describe(`Allow members to ${action}.`);

export const zInviteTrackerConfig = z.strictObject({
  log_channel_id: nullableChannelId("Optional channel for a log entry on every tracked join and leave, plus raid alerts."),
  ignore_bots: z.boolean().default(true).describe("Bots added to the server never count towards anyone's invites."),
  blacklist: z
    .strictObject({
      user_ids: z.array(z.string()).max(100).default([]).describe("Members who never earn invites, and whose joins never count."),
      role_ids: z.array(z.string()).max(25).default([]).describe("Inviters with any of these roles never earn invites."),
    })
    .default({}),
  count_on: z
    .enum(INVITE_COUNT_ON)
    .default("join")
    .describe("join = count as soon as someone joins, verified = only once they pass Passport verification."),
  passport: z
    .strictObject({
      pending_timeout_hours: z
        .number()
        .int()
        .min(1)
        .max(720)
        .default(72)
        .describe("A join still waiting on Passport after this long counts as fake (unverified)."),
    })
    .default({}),
  fake: z
    .strictObject({
      min_account_age_days: z
        .number()
        .int()
        .min(0)
        .max(365)
        .default(7)
        .describe("Accounts younger than this count as fake. 0 turns the check off."),
      rejoin_policy: z
        .enum(INVITE_REJOIN_POLICIES)
        .default("fake")
        .describe("count = a rejoin counts again, fake = it counts as fake, ignore = it isn't counted at all."),
      quick_leave_minutes: z
        .number()
        .int()
        .min(0)
        .max(43_200)
        .default(0)
        .describe("Members who leave within this many minutes are a quick leave. 0 turns it off."),
      quick_leave_as: z
        .enum(INVITE_QUICK_LEAVE_AS)
        .default("left")
        .describe("left = a quick leave counts as a normal leave, fake = it counts as fake."),
    })
    .default({}),
  join_message: z
    .strictObject({
      enabled: z.boolean().default(false).describe("Post a message when someone joins."),
      channel_id: nullableChannelId("Channel join messages are posted in."),
      message: zInviteMessage(DEFAULT_INVITE_JOIN_TEXT).describe("Posted when the inviter is known."),
      unknown_message: zInviteMessage(DEFAULT_INVITE_UNKNOWN_TEXT).describe(
        "Posted when there's no inviter: the vanity URL, a tracked link, a bot invite, or an unknown invite.",
      ),
    })
    .default({}),
  leave_message: z
    .strictObject({
      enabled: z.boolean().default(false).describe("Post a message when someone leaves."),
      channel_id: nullableChannelId("Channel leave messages are posted in."),
      message: zInviteMessage(DEFAULT_INVITE_LEAVE_TEXT),
    })
    .default({}),
  leaderboard: z
    .strictObject({
      show_left: z.boolean().default(true).describe("Show each member's left count on the leaderboard."),
      show_fake: z.boolean().default(true).describe("Show each member's fake count on the leaderboard."),
    })
    .default({}),
  raid: z
    .strictObject({
      enabled: z.boolean().default(false).describe("Watch for bursts of joins through the same invite."),
      threshold_joins: z.number().int().min(3).max(100).default(10).describe("Joins through one invite that count as a burst."),
      window_seconds: z.number().int().min(10).max(600).default(60).describe("How close together those joins must be."),
      action: z
        .enum(INVITE_RAID_ACTIONS)
        .default("alert")
        .describe("alert = post in the log channel, delete_invite = also delete the invite, pause_all = also pause every invite."),
      pause_minutes: z
        .number()
        .int()
        .min(15)
        .max(1440)
        .default(60)
        .describe("How long pause_all pauses invites for (at most 24 hours)."),
      alert_role_id: z.string().nullable().default(null).describe("Optional role pinged with raid alerts."),
    })
    .default({}),
  retention_days: z
    .number()
    .int()
    .min(30)
    .max(730)
    .default(365)
    .describe("Joins older than this are folded into daily totals. Invite counts only cover this window."),
  can_view: boolPermOn("see their own invites, the leaderboard and who invited someone with /invites"),
  can_view_others: boolPermOn("look up other members' invites with /invites"),
  can_manage: boolPerm("add bonus invites, reset counts and manage tracked links with /invites"),
  can_raid: boolPerm("pause and resume the server's invites with /invites raid"),
});

export type InviteTrackerConfig = z.infer<typeof zInviteTrackerConfig>;
export type InviteRejoinPolicy = (typeof INVITE_REJOIN_POLICIES)[number];
export type InviteRaidAction = (typeof INVITE_RAID_ACTIONS)[number];

export const zInviteTrackerPluginSection = zPluginSection(zInviteTrackerConfig.shape);
