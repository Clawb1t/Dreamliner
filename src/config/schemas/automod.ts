import { z } from "zod";
import { boolPerm, channelId } from "../schemaHelp.js";

export const AUTOMOD_RULE_IDS = [
  "profanity",
  "slurs",
  "excessive_swearing",
  "custom_filter",
  "spam",
  "emoji_spam",
  "duplicate",
  "copypasta",
  "sticker_gif_spam",
  "attachment_spam",
  "newline_spam",
  "wall_of_text",
  "repeated_chars",
  "mass_mentions",
  "everyone_here",
  "invites",
  "links",
  "excessive_caps",
  "zalgo",
  "raid",
] as const;

export type AutomodRuleId = (typeof AUTOMOD_RULE_IDS)[number];

export const AUTOMOD_ACTION_TYPES = [
  "delete",
  "warn",
  "mute",
  "kick",
  "softban",
  "ban",
  "tempban",
  "note",
  "none",
] as const;

export type AutomodActionType = (typeof AUTOMOD_ACTION_TYPES)[number];

export const AUTOMOD_SENSITIVITIES = ["lenient", "balanced", "strict", "custom"] as const;
export type AutomodSensitivity = (typeof AUTOMOD_SENSITIVITIES)[number];

export const AUTOMOD_PRESETS = ["light", "standard", "strict"] as const;
export type AutomodPresetName = (typeof AUTOMOD_PRESETS)[number];

export const zAutomodLadderAction = z.strictObject({
  type: z.enum(AUTOMOD_ACTION_TYPES).describe("Punishment or log action for this ladder step."),
  duration_ms: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Duration for mute/tempban in milliseconds."),
  reason: z.string().max(400).optional().describe("Optional reason override for the case."),
  notify: z
    .boolean()
    .optional()
    .describe("DM the member about this action when Discord allows."),
  delete_message_days: z
    .number()
    .int()
    .min(0)
    .max(7)
    .optional()
    .describe("How many days of messages to delete on softban/ban (0–7)."),
  points: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe("Infraction points recorded on the case metadata for this action."),
});

export const zAutomodLadderStep = z.strictObject({
  after: z
    .number()
    .int()
    .min(1)
    .describe("Run these actions once the user reaches this many points in the strike window."),
  actions: z
    .array(zAutomodLadderAction)
    .min(1)
    .describe("One or more actions to apply at this point threshold."),
});

export const zAutomodFilterEntry = z.strictObject({
  id: z.string().min(1).describe("Stable entry id."),
  pattern: z.string().min(1).max(200).describe("Word, phrase, or regex pattern."),
  regex: z.boolean().default(false).describe("Treat pattern as a regular expression."),
  enabled: z.boolean().default(true).describe("Whether this entry is active."),
});

export const zAutomodRuleConfig = z.strictObject({
  enabled: z.boolean().default(false).describe("Whether this rule is active."),
  sensitivity: z
    .enum(AUTOMOD_SENSITIVITIES)
    .default("balanced")
    .describe("Quick sensitivity preset for detector thresholds."),
  strike_window_ms: z
    .number()
    .int()
    .min(1000)
    .default(3_600_000)
    .describe("How long hits/points count toward the escalation ladder."),
  delete_message: z
    .boolean()
    .default(true)
    .describe("Delete the offending message when this rule hits (message rules)."),
  points: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(1)
    .describe("Points awarded each time this rule triggers (used for escalation thresholds)."),
  notify: z
    .boolean()
    .default(false)
    .describe("DM the member when this rule issues a case action (warn/mute/kick/ban)."),
  case_reason: z
    .string()
    .max(400)
    .optional()
    .describe("Optional case reason override for infractions created by this rule."),
  ignored_channels: z
    .array(z.string())
    .default([])
    .describe("Channels where this specific rule is skipped."),
  ignored_roles: z
    .array(z.string())
    .default([])
    .describe("Roles that bypass this specific rule."),
  ladder: z
    .array(zAutomodLadderStep)
    .default([{ after: 1, actions: [{ type: "delete" }] }])
    .describe("Escalation steps based on recent points for this rule."),
  settings: z
    .record(z.unknown())
    .default({})
    .describe("Rule-specific detector settings (thresholds, word packs, filter entries)."),
});

export const zAutomodMigrations = z.strictObject({
  legacy_v1: z.boolean().optional(),
  censor_v1: z.boolean().optional(),
  censor_db_v1: z.boolean().optional(),
});

export const zAutomodConfig = z.strictObject({
  presets_applied: z
    .enum(AUTOMOD_PRESETS)
    .nullable()
    .optional()
    .describe("Last one-click preset applied from the dashboard, if any."),
  ignored_channels: z
    .array(z.string())
    .default([])
    .describe("Channels automod should skip."),
  ignored_roles: z
    .array(z.string())
    .default([])
    .describe("Roles that bypass automod (mods/admins usually)."),
  log_channel_id: channelId("Optional channel for automod hits. Falls back to moderation logs if empty."),
  dm_users: z
    .boolean()
    .default(true)
    .describe("DM users when automod issues a warn (when Discord allows)."),
  rules: z
    .record(zAutomodRuleConfig)
    .default({})
    .describe("Per-rule configuration keyed by rule id."),
  migrations: zAutomodMigrations.default({}).describe("Internal one-time migration flags."),
  can_status: boolPerm("check automod status"),
  can_test: boolPerm("run automod tests"),
  can_configure: boolPerm("configure automod settings in Discord"),
});

export type AutomodLadderAction = z.infer<typeof zAutomodLadderAction>;
export type AutomodLadderStep = z.infer<typeof zAutomodLadderStep>;
export type AutomodFilterEntry = z.infer<typeof zAutomodFilterEntry>;
export type AutomodRuleConfig = z.infer<typeof zAutomodRuleConfig>;
export type AutomodConfig = z.infer<typeof zAutomodConfig>;
