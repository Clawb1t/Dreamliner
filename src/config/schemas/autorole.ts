import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";
import { zPluginOverride } from "./pluginSection.js";

export const zAutoroleRoleEntry = z.strictObject({
  role: z.string().describe("Role ID to assign on join."),
  delay_ms: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Wait this many milliseconds after join before assigning the role."),
  delay: z.string().optional().describe("Optional human delay string (alternative to delay_ms)."),
});

export const zAutoroleConfig = z.strictObject({
  roles: z
    .array(z.union([z.string(), zAutoroleRoleEntry]))
    .default([])
    .describe(
      "Roles to assign when a member joins. Use a role ID string, or an object with role + delay_ms.",
    ),
  can_add: boolPerm("add autorole entries"),
  can_remove: boolPerm("remove autorole entries"),
  can_list: boolPerm("list autorole entries"),
});

export const zAutorolePluginSection = z.strictObject({
  enabled: z.boolean().optional().describe("Turn autorole on or off for this server."),
  config: zAutoroleConfig.partial().optional(),
  overrides: z.array(zPluginOverride).optional(),
  replaceDefaultOverrides: z
    .boolean()
    .optional()
    .describe("When true, ignore Dreamliner's built-in default level grants for this plugin."),
});

export type AutoroleConfig = z.infer<typeof zAutoroleConfig>;
export type AutoroleRoleEntry = z.infer<typeof zAutoroleRoleEntry>;

export type NormalizedAutoroleEntry = {
  roleId: string;
  delayMs: number;
};
