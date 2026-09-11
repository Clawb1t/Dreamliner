import { z } from "zod";
import { zPluginSection } from "./pluginSection.js";

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
});

export const zAutorolePluginSection = zPluginSection(zAutoroleConfig.shape);

export type AutoroleConfig = z.infer<typeof zAutoroleConfig>;
export type AutoroleRoleEntry = z.infer<typeof zAutoroleRoleEntry>;
export type AutoroleAudience = "humans" | "bots";

export type NormalizedAutoroleEntry = {
  roleId: string;
  delayMs: number;
};
