import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";

const roleListDescription =
  "Use a role ID string, or an object with role + delay_ms (or delay).";

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

const zAutoroleRoleList = z.array(z.union([z.string(), zAutoroleRoleEntry])).default([]);

export const zAutoroleConfig = z.strictObject({
  roles: zAutoroleRoleList.describe(
    `Roles for humans only. Assigned when a person joins. ${roleListDescription}`,
  ),
  bot_roles: zAutoroleRoleList.describe(
    `Roles for bots only. Assigned when a bot joins. ${roleListDescription}`,
  ),
  can_add: boolPerm("add autorole entries"),
  can_remove: boolPerm("remove autorole entries"),
  can_list: boolPerm("list autorole entries"),
});

export const zAutorolePluginSection = z.strictObject({
  enabled: z.boolean().optional().describe("Turn autorole on or off for this server."),
  config: zAutoroleConfig.partial().optional(),
});

export type AutoroleConfig = z.infer<typeof zAutoroleConfig>;
export type AutoroleRoleEntry = z.infer<typeof zAutoroleRoleEntry>;
export type AutoroleAudience = "humans" | "bots";

export type NormalizedAutoroleEntry = {
  roleId: string;
  delayMs: number;
};
