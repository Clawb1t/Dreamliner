import { zRolesConfig } from "../../../config/schemas/plugins.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";

export function loadRolesConfig(guildConfig: GuildConfig) {
  return parsePluginConfig(zRolesConfig, getPluginSettings(guildConfig, "roles"));
}
