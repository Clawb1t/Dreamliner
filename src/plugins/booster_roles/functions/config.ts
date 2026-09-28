import { zBoosterRolesConfig, type BoosterRolesConfig, type BoosterRoleTier } from "../../../config/schemas/boosterRoles.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";

export function loadBoosterRolesConfig(guildConfig: GuildConfig): BoosterRolesConfig {
  return parsePluginConfig(zBoosterRolesConfig, getPluginSettings(guildConfig, "booster_roles"));
}

/** The number a tier is earned at: days boosting, or boosts given. */
export function tierThreshold(tier: BoosterRoleTier): number {
  return tier.requirement === "boosts" ? tier.boost_count : tier.duration_days;
}

/** Enabled tiers with a role set: duration tiers first, then boost-count tiers, each ascending. */
export function activeTiers(config: BoosterRolesConfig): BoosterRoleTier[] {
  return config.tiers
    .filter((tier) => tier.enabled !== false && tier.role_id.trim().length > 0)
    .sort(
      (a, b) =>
        Number(a.requirement === "boosts") - Number(b.requirement === "boosts") || tierThreshold(a) - tierThreshold(b),
    );
}

export function hasBoostCountTiers(config: BoosterRolesConfig): boolean {
  return activeTiers(config).some((tier) => tier.requirement === "boosts");
}
