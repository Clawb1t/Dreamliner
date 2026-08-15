import type { GuildConfig } from "../../../config/schemas/guild.js";
import { zPassportConfig, type PassportConfig } from "../../../config/schemas/passport.js";
import { resolvePluginConfig } from "../../../core/permissions.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { passportDefaultOverrides } from "../defaultOverrides.js";

export function getPassportConfig(guildConfig: GuildConfig): PassportConfig {
  return parsePluginConfig(
    zPassportConfig,
    resolvePluginConfig(guildConfig, "passport", passportDefaultOverrides),
  );
}

export function isPassportEnabled(guildConfig: GuildConfig): boolean {
  return pluginEnabled(guildConfig, "passport");
}
