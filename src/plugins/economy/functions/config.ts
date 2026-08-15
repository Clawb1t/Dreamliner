import { zEconomyConfig, type EconomyConfig } from "../../../config/schemas/economy.js";
import { configManager } from "../../../config/manager.js";
import { getPluginDefaultOverrides } from "../../../core/guildHelpers.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { resolvePluginConfig } from "../../../core/permissions.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import { economyDefaultOverrides } from "../defaultOverrides.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";

export function getEconomyConfig(guildConfig: GuildConfig): EconomyConfig {
  return parsePluginConfig(
    zEconomyConfig,
    resolvePluginConfig(guildConfig, "economy", economyDefaultOverrides),
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
    resolvePluginConfig(guildConfig, "economy", getPluginDefaultOverrides("economy")),
  );
}

export async function loadEconomyConfigOrThrow(guildId: string): Promise<EconomyConfig> {
  const config = await loadEconomyConfig(guildId);
  if (!config) throw new Error("Economy plugin is disabled.");
  return config;
}
