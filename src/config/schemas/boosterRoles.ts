import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";

export const zBoosterRoleTier = z.strictObject({
  enabled: z.boolean().default(true).describe("Turn this tier on or off without deleting it."),
  name: z.string().max(80).default("").describe("Optional label shown in the dashboard and /booster roles."),
  role_id: z.string().min(1).describe("Role granted once a booster reaches this tier's duration."),
  duration_days: z
    .number()
    .int()
    .min(0)
    .max(3650)
    .default(0)
    .describe("Continuous boosting days required to earn this tier (0 = immediately on boosting)."),
});

export const zBoosterRolesConfig = z.strictObject({
  stacking: z
    .boolean()
    .default(false)
    .describe(
      "If true, boosters keep every tier role they've earned. If false (default), only the highest tier a booster currently qualifies for is kept — lower tier roles are removed as they move up.",
    ),
  tiers: z.array(zBoosterRoleTier).default([]).describe("Boost-duration tiers, one role each."),
  can_view: boolPerm("view the server's booster role tiers with /booster roles"),
  can_recheck: boolPerm("manually recheck their own boost duration against the tiers with /booster recheck"),
});

export type BoosterRoleTier = z.infer<typeof zBoosterRoleTier>;
export type BoosterRolesConfig = z.infer<typeof zBoosterRolesConfig>;
