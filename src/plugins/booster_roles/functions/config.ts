import { zBoosterRolesConfig, type BoosterRolesConfig, type BoosterRoleTier } from "../../../config/schemas/boosterRoles.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";

export function loadBoosterRolesConfig(guildConfig: GuildConfig): BoosterRolesConfig {
  return parsePluginConfig(zBoosterRolesConfig, getPluginSettings(guildConfig, "booster_roles"));
}

/** Enabled tiers with a role set, sorted ascending by the duration required to earn them. */
export function activeTiers(config: BoosterRolesConfig): BoosterRoleTier[] {
  return config.tiers
    .filter((tier) => tier.enabled !== false && tier.role_id.trim().length > 0)
    .sort((a, b) => a.duration_days - b.duration_days);
}
