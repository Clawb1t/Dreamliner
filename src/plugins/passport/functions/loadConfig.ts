import type { GuildConfig } from "../../../config/schemas/guild.js";
import { zPassportConfig, type PassportConfig } from "../../../config/schemas/passport.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";

export function getPassportConfig(guildConfig: GuildConfig): PassportConfig {
  return parsePluginConfig(
    zPassportConfig,
    getPluginSettings(guildConfig, "passport"),
  );
}

export function isPassportEnabled(guildConfig: GuildConfig): boolean {
  return pluginEnabled(guildConfig, "passport");
}
