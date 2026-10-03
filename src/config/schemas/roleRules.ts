import { z } from "zod";

/** Up to this many rules per server, and roles per list in a rule. */
export const MAX_ROLE_RULES = 25;
export const MAX_RULE_ROLES = 10;

const roleIdList = (description: string) =>
  z
    .array(z.string().regex(/^\d{15,22}$/, "Must be a role ID"))
    .max(MAX_RULE_ROLES)
    .default([])
    .describe(description);

/**
 * An if-then role rule: when a member has the "if" roles (all of them, or any), the bot gives and
 * removes roles. E.g. Role A + Role B → take both away and give Role C.
 */
export const zRoleRule = z.strictObject({
  enabled: z.boolean().default(true).describe("Turn this rule off without deleting it."),
  name: z.string().max(80).default("").describe("A label for the dashboard and the audit log."),
  match: z
    .enum(["all", "any"])
    .default("all")
    .describe("all: the member needs every role in if_roles. any: one of them is enough."),
  if_roles: roleIdList("The roles that trigger this rule."),
  unless_roles: roleIdList("Members with any of these roles are skipped."),
  give_roles: roleIdList("Roles given when the rule triggers."),
  remove_roles: roleIdList("Roles taken away when the rule triggers."),
  remove_matched: z
    .boolean()
    .default(false)
    .describe("Also take away the if_roles the member had that triggered the rule."),
});

export type RoleRule = z.infer<typeof zRoleRule>;
