import { zEconomyConfig, type EconomyConfig } from "../../../config/schemas/economy.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";

export function getEconomyConfig(guildConfig: GuildConfig): EconomyConfig {
  return parsePluginConfig(
    zEconomyConfig,
    getPluginSettings(guildConfig, "economy"),
  );
}

export function isEconomyEnabled(guildConfig: GuildConfig): boolean {
  return pluginEnabled(guildConfig, "economy");
}

/** Load parsed economy config for a guild, or null if the plugin is disabled. */
export async function loadEconomyConfig(guildId: string): Promise<EconomyConfig | null> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  if (!pluginEnabled(guildConfig, "economy")) return null;
  return parsePluginConfig(
    zEconomyConfig,
    getPluginSettings(guildConfig, "economy"),
  );
}
