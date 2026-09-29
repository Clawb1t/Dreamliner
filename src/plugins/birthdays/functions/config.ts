import { zBirthdaysConfig, type BirthdaysConfig } from "../../../config/schemas/birthdays.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { configManager } from "../../../config/manager.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";

export const PLUGIN = "birthdays";

export function loadBirthdaysConfig(guildConfig: GuildConfig): BirthdaysConfig {
  return parsePluginConfig(zBirthdaysConfig, getPluginSettings(guildConfig, PLUGIN));
}

/** The server's Birthdays config when the plugin is on and has something to do, else null. */
export async function loadActiveBirthdays(guildId: string): Promise<BirthdaysConfig | null> {
  const guildConfig = await configManager.getEffectiveConfig(guildId).catch(() => null);
  if (!guildConfig || !pluginEnabled(guildConfig, PLUGIN)) return null;
  const config = loadBirthdaysConfig(guildConfig);
  const announces = config.announcement.enabled && Boolean(config.announcement.channel_id?.trim());
  const gives = config.role.enabled && Boolean(config.role.role_id.trim());
  return announces || gives || config.dm.enabled ? config : null;
}

/** The timezone a member's birthday runs on: their own when the server uses members' timezones
 *  and they set one, otherwise the server's. */
export function effectiveTimezone(config: BirthdaysConfig, memberTimezone: string | null | undefined): string {
  return config.timezone_mode === "member" && memberTimezone ? memberTimezone : config.timezone;
}
