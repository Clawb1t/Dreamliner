import { z } from "zod";
import { boolPerm, channelId, roleId } from "../schemaHelp.js";
import { zPluginOverride } from "./pluginSection.js";

const notifyActionSchema = z.strictObject({
  dm: z.boolean().default(true).describe("Send the member a DM when this action is taken."),
  format: z.string().optional().describe("Optional custom DM message template for this action."),
});

export const zInfractionConfig = z.strictObject({
  confirm_actions: z
    .boolean()
    .default(true)
    .describe("Ask for confirmation before applying moderation actions."),
  confirm_actions_expiry: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Seconds before a confirmation prompt expires. 0 uses the bot default."),
  mute_role: roleId("Role applied for mutes. Create a muted role and paste its ID here."),
  case_log_channel: channelId("Optional channel for case logs. Falls back to moderation_log_channel_id."),
  reason_edit_level: z
    .number()
    .int()
    .default(100)
    .describe("Minimum permission level required to edit case reasons."),
  duration_edit_level: z
    .number()
    .int()
    .default(100)
    .describe("Minimum permission level required to edit timed mute/ban durations."),
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
  overrides: z.array(zPluginOverride).optional(),
  replaceDefaultOverrides: z
    .boolean()
    .optional()
    .describe("When true, ignore Dreamliner's built-in default level grants for this plugin."),
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
