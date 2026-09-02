import {
  zAutodeleteConfig,
  type AutodeleteConfig,
  type AutodeleteRule,
} from "../../../config/schemas/autodelete.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";

export function loadAutodeleteConfig(guildConfig: GuildConfig): AutodeleteConfig {
  return parsePluginConfig(zAutodeleteConfig, getPluginSettings(guildConfig, "autodelete"));
}

/** Last matching enabled rule wins when two rules share a channel. */
export function autodeleteRuleByChannel(config: AutodeleteConfig): Map<string, AutodeleteRule> {
  const map = new Map<string, AutodeleteRule>();
  for (const rule of config.rules) {
    const channelId = rule.channel_id.trim();
    if (!channelId || rule.enabled === false) continue;
    map.set(channelId, { ...rule, channel_id: channelId });
  }
  return map;
}
