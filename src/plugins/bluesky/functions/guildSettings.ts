import type { GuildConfig } from "../../../config/schemas/guild.js";
import { zBlueskyConfig, type BlueskyConfig } from "../../../config/schemas/bluesky.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";

/** The server-wide Bluesky settings with defaults filled in (no member/channel overrides). */
export function getBlueskySettings(guildConfig: GuildConfig): BlueskyConfig {
  const parsed = zBlueskyConfig.safeParse({ ...zBlueskyConfig.parse({}), ...(guildConfig.plugins.bluesky?.config ?? {}) });
  return parsed.success ? parsed.data : zBlueskyConfig.parse({});
}

/** Plugin on, plus its settings, for event handlers that run outside a command. Null when off. */
export async function activeBlueskySettings(guildId: string): Promise<BlueskyConfig | null> {
  const guildConfig = await configManager.getEffectiveConfig(guildId).catch(() => null);
  if (!guildConfig || !pluginEnabled(guildConfig, "bluesky")) return null;
  return getBlueskySettings(guildConfig);
}
