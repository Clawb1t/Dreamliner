import type { GuildConfig } from "../../../config/schemas/guild.js";
import { zSlowmodeConfig, type SlowmodeConfig } from "../../../config/schemas/plugins.js";
import { getPluginBaseConfig } from "../../../core/pluginSchemas.js";

/**
 * Guild-level slowmode config (rules / toggles).
 * Intentionally ignores member permission overrides so `can_*` grants
 * cannot alter enforcement rules mid-resolve.
 */
export function getSlowmodeGuildConfig(guildConfig: GuildConfig): SlowmodeConfig {
  const section = guildConfig.plugins.slowmode as { config?: Record<string, unknown> } | undefined;
  return zSlowmodeConfig.parse({
    ...getPluginBaseConfig("slowmode"),
    ...(section?.config ?? {}),
  });
}
