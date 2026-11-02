import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";
import { zPluginSection } from "./pluginSection.js";

/** Activity periods quotas and reports are measured over (UTC). */
export const TEAM_PERIODS = ["weekly", "biweekly", "monthly"] as const;
export const TEAM_WEEK_STARTS = ["monday", "sunday"] as const;
/** What reaching a strike threshold does. */
export const TEAM_STRIKE_ACTIONS = ["notify", "demote", "suspend", "terminate"] as const;

/** The most anything can be with Dreamliner One. Free servers get lower limits at runtime (see
 *  the plugin's oneGate.ts), so a config saved while One was active never fails validation. */
export const TEAM_MAX_RANKS = 25;
export const TEAM_MAX_SHIFT_TYPES = 15;
export const TEAM_MAX_CHECKLIST = 40;

/** Stable short ids for ranks, shift types and checklist items. */
const zSlug = z
  .string()
  .regex(/^[a-z0-9_-]{1,32}$/, "Use 1-32 lowercase letters, numbers, - or _.")
  .describe("Short stable id (lowercase letters, numbers, - and _). Don't change it once in use.");

const nullableId = (help: string) => z.string().nullable().default(null).describe(help);
const nullableChannelId = (help: string) =>
  nullableId(`${help} Paste a Discord channel ID (Developer Mode → right-click channel → Copy Channel ID).`);
const nullableRoleId = (help: string) => nullableId(`${help} Paste a Discord role ID.`);

/** A `can_*` flag that defaults on, for things every member should be able to do. */
const boolPermOn = (action: string) => z.boolean().default(true).describe(`Allow members to ${action}.`);

const quotaNumber = (max: number, help: string) => z.number().min(0).max(max).default(0).describe(`${help} 0 = not required.`);

export const zTeamRank = z.strictObject({
  id: zSlug,
  name: z.string().min(1).max(50).describe("Rank name shown on the roster, profiles and announcements."),
  role_id: z.string().nullable().default(null).describe("Discord role that puts a member at this rank."),
  quota: z
    .strictObject({
      shift_hours: quotaNumber(500, "Hours on shift per period (breaks excluded)."),
      mod_actions: quotaNumber(10_000, "Moderation actions per period."),
      tickets: quotaNumber(10_000, "Tickets closed per period."),
      messages: quotaNumber(100_000, "Messages in staff channels per period."),
      voice_hours: quotaNumber(500, "Hours in voice per period."),
    })
    .default({}),
  points_quota: z.number().min(0).max(100_000).default(0).describe("Points needed per period in points mode (Dreamliner One). 0 = none."),
});

export const zTeamControlConfig = z.strictObject({
  ranks: z
    .array(zTeamRank)
    .max(TEAM_MAX_RANKS)
    .default([])
    .describe("The staff rank ladder, lowest first. A member's rank is the highest rank role they hold."),
  manager_role_ids: z
    .array(z.string())
    .max(25)
    .default([])
    .describe("Roles pinged for leave requests and alerts when no more specific ping role is set."),
  log_channel_id: nullableChannelId("Default log channel for everything below that has no channel of its own."),
  shifts: z
    .strictObject({
      enabled: z.boolean().default(true).describe("Let staff clock in and out."),
      duty_role_id: nullableRoleId("Optional role given while on shift."),
      nickname_prefix: z.string().max(12).default("").describe('Optional nickname prefix while on shift, e.g. "[On duty] ".'),
      log_channel_id: nullableChannelId("Channel shift starts and ends are logged in."),
      types: z
        .array(
          z.strictObject({
            id: zSlug,
            name: z.string().min(1).max(40),
            rank_ids: z.array(z.string()).max(TEAM_MAX_RANKS).default([]).describe("Ranks that can use this type. Empty = every rank."),
          }),
        )
        .max(TEAM_MAX_SHIFT_TYPES)
        .default([])
        .describe("Optional shift types, e.g. Moderation or Support."),
      allow_breaks: z.boolean().default(true).describe("Let staff pause a shift. Break time doesn't count."),
      min_minutes: z.number().int().min(0).max(120).default(5).describe("Shifts shorter than this are voided."),
      max_hours: z.number().int().min(1).max(48).default(12).describe("Shifts longer than this are ended automatically."),
      max_on_duty: z.number().int().min(0).max(500).default(0).describe("Most staff on shift at once. 0 = no limit."),
      block_on_loa: z.boolean().default(true).describe("Staff on approved leave of absence can't clock in."),
    })
    .default({}),
  leave: z
    .strictObject({
      enabled: z.boolean().default(true).describe("Let staff request leave of absence (LOA) or reduced activity (RA)."),
      loa_role_id: nullableRoleId("Role given while on leave of absence."),
      ra_role_id: nullableRoleId("Role given while on reduced activity."),
      request_channel_id: nullableChannelId("Channel leave requests are posted in for review."),
      log_channel_id: nullableChannelId("Channel leave decisions are logged in."),
      ping_role_id: nullableRoleId("Role pinged for new leave requests (defaults to the manager roles)."),
      require_reason: z.boolean().default(true).describe("Leave requests need a reason."),
      min_days: z.number().int().min(1).max(30).default(1),
      max_days: z.number().int().min(1).max(365).default(60),
      cooldown_days: z.number().int().min(0).max(90).default(0).describe("Days after a decision before the member can request again."),
      auto_approve: z.boolean().default(false).describe("Approve every request automatically."),
      exempt_from_quota: z.boolean().default(true).describe("Staff on leave for at least half a period are excused from its quota."),
    })
    .default({}),
  actions: z
    .strictObject({
      enabled: z.boolean().default(true).describe("Promotions, demotions, warnings, strikes, suspensions and terminations."),
      log_channel_id: nullableChannelId("Channel staff actions are logged in."),
      announce_channel_id: nullableChannelId("Optional channel promotions and demotions are announced in."),
      dm_member: z.boolean().default(true).describe("DM the member about actions taken on them."),
      require_reason: z.boolean().default(true),
      suspended_role_id: nullableRoleId("Optional role given while suspended."),
      strike_expiry_days: z.number().int().min(0).max(730).default(90).describe("Strikes stop counting after this many days. 0 = never."),
      strike_thresholds: z
        .array(
          z.strictObject({
            strikes: z.number().int().min(1).max(20),
            action: z.enum(TEAM_STRIKE_ACTIONS),
            suspend_days: z.number().int().min(1).max(90).default(7),
          }),
        )
        .max(10)
        .default([{ strikes: 3, action: "notify", suspend_days: 7 }])
        .describe("What happens when a member's active strikes reach a count."),
    })
    .default({}),
  activity: z
    .strictObject({
      enabled: z.boolean().default(true).describe("Track staff activity and quotas."),
      period: z.enum(TEAM_PERIODS).default("weekly"),
      week_start: z.enum(TEAM_WEEK_STARTS).default("monday"),
      staff_channel_ids: z.array(z.string()).max(50).default([]).describe("Channels whose messages count as staff messages."),
      inactivity_days: z.number().int().min(0).max(60).default(7).describe("Alert after this many days without activity. 0 = off."),
      report_channel_id: nullableChannelId("Channel activity reports are posted in."),
      scheduled_reports: z.boolean().default(false).describe("Post a report at the end of every period (Dreamliner One)."),
      points_mode: z.boolean().default(false).describe("Measure quotas in weighted points instead of per-metric targets (Dreamliner One)."),
      weights: z
        .strictObject({
          shift_hour: z.number().min(0).max(100).default(10),
          mod_action: z.number().min(0).max(100).default(2),
          ticket: z.number().min(0).max(100).default(3),
          message: z.number().min(0).max(100).default(0.1),
          voice_hour: z.number().min(0).max(100).default(2),
        })
        .default({}),
    })
    .default({}),
  roster: z
    .strictObject({
      enabled: z.boolean().default(false).describe("Keep a live roster message up to date."),
      channel_id: nullableChannelId("Channel the roster is posted in."),
      show_buttons: z.boolean().default(true).describe("Clock in, break and clock out buttons under the roster."),
      title: z.string().min(1).max(100).default("Team roster"),
    })
    .default({}),
  feedback: z
    .strictObject({
      enabled: z.boolean().default(true).describe("Let members rate staff."),
      after_ticket: z.boolean().default(true).describe("Ask the ticket opener to rate the staff member when a ticket closes."),
      direct: z.boolean().default(true).describe("Let members rate staff with /team rate."),
      cooldown_hours: z.number().int().min(1).max(720).default(24).describe("Hours before the same member can rate the same staff member again."),
      members_only: z.boolean().default(true).describe("Staff can't rate each other."),
      log_channel_id: nullableChannelId("Channel new feedback is logged in."),
    })
    .default({}),
  onboarding: z
    .strictObject({
      enabled: z.boolean().default(false).describe("Checklists and trial periods for new staff."),
      checklist: z
        .array(
          z.strictObject({
            id: zSlug,
            label: z.string().min(1).max(80),
            description: z.string().max(200).default(""),
          }),
        )
        .max(TEAM_MAX_CHECKLIST)
        .default([]),
      trial_rank_id: z.string().nullable().default(null).describe("Rank new staff are on trial at. Empty = any rank."),
      trial_days: z.number().int().min(0).max(90).default(14).describe("Trial length. 0 = no trial."),
      review_channel_id: nullableChannelId("Channel trial reviews are posted in."),
      dm_welcome: z.boolean().default(true).describe("DM new staff a welcome with their checklist."),
    })
    .default({}),
  can_view_team: boolPermOn("see the roster, other staff profiles and the leaderboard with /team"),
  can_shift: boolPerm("clock in with /team shift without holding a rank role"),
  can_request_leave: boolPerm("request leave with /team leave without holding a rank role"),
  can_rate: boolPermOn("rate staff with /team rate"),
  can_review_leave: boolPerm("approve and deny leave requests"),
  can_discipline: boolPerm("warn, strike, suspend and terminate staff with /team action"),
  can_promote: boolPerm("promote and demote staff with /team action"),
  can_manage: boolPerm("edit shifts, write notes, manage onboarding, run reports and sync the team"),
});

export type TeamControlConfig = z.infer<typeof zTeamControlConfig>;
export type TeamRank = z.infer<typeof zTeamRank>;
export type TeamPeriodKind = (typeof TEAM_PERIODS)[number];
export type TeamWeekStart = (typeof TEAM_WEEK_STARTS)[number];
export type TeamStrikeAction = (typeof TEAM_STRIKE_ACTIONS)[number];
export type TeamStrikeThreshold = TeamControlConfig["actions"]["strike_thresholds"][number];
export type TeamQuota = TeamRank["quota"];
export type TeamWeights = TeamControlConfig["activity"]["weights"];

export const zTeamControlPluginSection = zPluginSection(zTeamControlConfig.shape);
