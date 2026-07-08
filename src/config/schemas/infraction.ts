import { z } from "zod";

const pluginOverrideSchema = z.strictObject({
  level: z.string().optional(),
  channel: z.string().optional(),
  category: z.string().optional(),
  user: z.string().optional(),
  config: z.record(z.unknown()),
});

const notifyActionSchema = z.strictObject({
  dm: z.boolean().default(true),
  format: z.string().optional(),
});

export const zInfractionConfig = z.strictObject({
  confirm_actions: z.boolean().default(true),
  confirm_actions_expiry: z.number().int().min(0).default(0),
  mute_role: z.string().optional(),
  case_log_channel: z.string().optional(),
  reason_edit_level: z.number().int().default(100),
  duration_edit_level: z.number().int().default(100),
  ban_delete_message_days: z.number().int().min(0).max(7).default(0),
  softban_delete_message_days: z.number().int().min(0).max(7).default(7),
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
    .default({}),
  can_warn: z.boolean().default(false),
  can_note: z.boolean().default(false),
  can_mute: z.boolean().default(false),
  can_kick: z.boolean().default(false),
  can_ban: z.boolean().default(false),
  can_unban: z.boolean().default(false),
  can_softban: z.boolean().default(false),
  can_view: z.boolean().default(false),
  can_edit_reason: z.boolean().default(false),
  can_edit_duration: z.boolean().default(false),
  can_delete: z.boolean().default(false),
});

export type InfractionConfig = z.infer<typeof zInfractionConfig>;

export const zInfractionPluginSection = z.strictObject({
  enabled: z.boolean().optional(),
  config: zInfractionConfig.partial().optional(),
  overrides: z.array(pluginOverrideSchema).optional(),
  replaceDefaultOverrides: z.boolean().optional(),
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
