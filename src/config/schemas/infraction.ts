import { z } from "zod";
import { boolPerm, channelId } from "../schemaHelp.js";

const notifyActionSchema = z.strictObject({
  dm: z.boolean().default(true).describe("Send the member a DM when this action is taken."),
  format: z.string().optional().describe("Optional custom DM message template for this action."),
});

/** Infraction types that can require a reason before the command runs. */
export const REASON_REQUIRABLE_TYPES = ["warn", "mute", "kick", "ban", "tempban", "softban"] as const;

/** Infraction types that can feed the auto-escalation strike count. */
export const ESCALATION_COUNT_TYPES = ["warn", "mute", "tempmute", "kick", "softban", "tempban", "ban"] as const;

/** Punishments an escalation step can apply automatically. */
export const ESCALATION_STEP_TYPES = ["mute", "kick", "softban", "tempban", "ban"] as const;

export type ReasonRequirableType = (typeof REASON_REQUIRABLE_TYPES)[number];
export type EscalationCountType = (typeof ESCALATION_COUNT_TYPES)[number];
export type EscalationStepType = (typeof ESCALATION_STEP_TYPES)[number];

const zRequireReason = z
  .strictObject(
    Object.fromEntries(
      REASON_REQUIRABLE_TYPES.map((type) => [type, z.boolean().default(false)]),
    ) as Record<ReasonRequirableType, z.ZodDefault<z.ZodBoolean>>,
  )
  .default({})
  .describe("Per-action toggle: block the command with an error if no reason is given.");

const zDefaultDuration = z
  .strictObject({
    tempmute: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Fallback /mute duration (ms) when no duration option is given."),
    tempban: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Fallback /tempban duration (ms) when no duration option is given."),
  })
  .default({})
  .describe("Default durations used when a timed command's duration option is left blank.");

const zEscalationStep = z.strictObject({
  after: z
    .number()
    .int()
    .min(1)
    .describe("Trigger this step when the member reaches this many qualifying infractions."),
  type: z.enum(ESCALATION_STEP_TYPES).describe("Punishment to apply automatically."),
  duration_ms: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Duration in milliseconds for mute/tempban steps. Omit for a permanent ban/kick/softban."),
});

export type EscalationStep = z.infer<typeof zEscalationStep>;

const zEscalation = z
  .strictObject({
    enabled: z
      .boolean()
      .default(false)
      .describe("Automatically apply a punishment once a member reaches a configured strike count."),
    count_types: z
      .array(z.enum(ESCALATION_COUNT_TYPES))
      .default(["warn"])
      .describe("Infraction types that count toward the strike total."),
    window_ms: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Only count infractions issued within this many milliseconds. 0 counts all-time."),
    steps: z
      .array(zEscalationStep)
      .default([])
      .describe("Ladder of strike counts and the punishment to auto-apply at each."),
  })
  .default({})
  .describe("Automatic escalation ladder for repeat offenders, applied after each qualifying infraction.");

export type EscalationConfig = z.infer<typeof zEscalation>;

export const zInfractionConfig = z.strictObject({
  case_log_channel: channelId("Optional channel for case logs. Falls back to moderation_log_channel_id."),
  ban_delete_message_days: z
    .number()
    .int()
    .min(0)
    .max(7)
    .default(0)
    .describe("How many days of the banned user's messages to delete (0–7)."),
  softban_delete_message_days: z
    .number()
    .int()
    .min(0)
    .max(7)
    .default(7)
    .describe("How many days of messages to delete on softban (0–7)."),
  notify: z
    .strictObject({
      warn: notifyActionSchema.default({}),
      mute: notifyActionSchema.default({}),
      tempmute: notifyActionSchema.default({}),
      kick: notifyActionSchema.default({}),
      ban: notifyActionSchema.default({}),
      tempban: notifyActionSchema.default({}),
      softban: notifyActionSchema.default({}),
    })
    .default({})
    .describe("DM notification settings for each punishment type."),
  require_reason: zRequireReason,
  default_duration: zDefaultDuration,
  escalation: zEscalation,
  can_warn: boolPerm("warn members"),
  can_note: boolPerm("add notes to members"),
  can_mute: boolPerm("mute members"),
  can_kick: boolPerm("kick members"),
  can_ban: boolPerm("ban members"),
  can_unban: boolPerm("unban members"),
  can_softban: boolPerm("softban members"),
  can_view: boolPerm("view cases / infraction history"),
  can_edit_reason: boolPerm("edit case reasons"),
  can_edit_duration: boolPerm("edit timed punishment durations"),
  can_delete: boolPerm("delete cases"),
});

export type InfractionConfig = z.infer<typeof zInfractionConfig>;

export const zInfractionPluginSection = z.strictObject({
  enabled: z.boolean().optional().describe("Turn infractions on or off for this server."),
  config: zInfractionConfig.partial().optional(),
});

export type InfractionPluginSection = z.infer<typeof zInfractionPluginSection>;

export const INFRACTION_TYPES = [
  "warn",
  "note",
  "mute",
  "tempmute",
  "unmute",
  "kick",
  "ban",
  "tempban",
  "unban",
  "softban",
] as const;

export type InfractionType = (typeof INFRACTION_TYPES)[number];
