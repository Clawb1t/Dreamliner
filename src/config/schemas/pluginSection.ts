import { z } from "zod";

export const zPluginOverride = z.strictObject({
  level: z
    .string()
    .optional()
    .describe('Match members by level expression, e.g. ">=50" or ">100".'),
  channel: z.string().optional().describe("Only apply in this channel ID."),
  category: z.string().optional().describe("Only apply in channels under this category ID."),
  user: z.string().optional().describe("Only apply to this user ID."),
  role: z.string().optional().describe("Only apply to members who have this role ID."),
  config: z
    .record(z.unknown())
    .describe("Config values to merge when this override matches (usually can_* permissions)."),
});

export function zPluginSection<T extends z.ZodRawShape>(configShape: T) {
  return z.strictObject({
    enabled: z.boolean().optional().describe("Turn this plugin on or off for the server."),
    config: z.strictObject(configShape).partial().optional(),
    overrides: z
      .array(zPluginOverride)
      .optional()
      .describe("Conditional config merges. Use these to grant can_* permissions to mods/admins."),
    replaceDefaultOverrides: z
      .boolean()
      .optional()
      .describe("When true, ignore Dreamliner's built-in default level grants for this plugin."),
  });
}

export type PluginOverride = z.infer<typeof zPluginOverride>;
