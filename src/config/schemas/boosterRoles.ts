import { z } from "zod";
import { boolPerm } from "../schemaHelp.js";

export const BOOSTER_TIER_REQUIREMENTS = ["duration", "boosts"] as const;
export type BoosterTierRequirement = (typeof BOOSTER_TIER_REQUIREMENTS)[number];

export const zBoosterRoleTier = z.strictObject({
  enabled: z.boolean().default(true).describe("Turn this tier on or off without deleting it."),
  name: z.string().max(80).default("").describe("Optional label shown in the dashboard and /booster roles."),
  role_id: z.string().min(1).describe("Role granted once a booster reaches this tier."),
  requirement: z
    .enum(BOOSTER_TIER_REQUIREMENTS)
    .default("duration")
    .describe("What earns this tier: how long the member has been boosting, or how many boosts they have given."),
  duration_days: z
    .number()
    .int()
    .min(0)
    .max(3650)
    .default(0)
    .describe("Duration tiers: continuous boosting days required (0 = immediately on boosting)."),
  boost_count: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(2)
    .describe("Boost-count tiers: boosts the member must have given during their current boosting streak."),
});

export const zBoosterRolesConfig = z.strictObject({
  stacking: z
    .boolean()
    .default(false)
    .describe(
      "If true, boosters keep every tier role they've earned. If false (default), only the highest tier a booster currently qualifies for is kept, per kind (duration and boost count), and lower tier roles are removed as they move up.",
    ),
  tiers: z.array(zBoosterRoleTier).default([]).describe("Booster tiers, one role each, earned by boost duration or boost count."),
  can_view: boolPerm("view the server's booster role tiers with /booster roles"),
  can_recheck: boolPerm("manually recheck their own boost duration against the tiers with /booster recheck"),
});

export type BoosterRoleTier = z.infer<typeof zBoosterRoleTier>;
export type BoosterRolesConfig = z.infer<typeof zBoosterRolesConfig>;
