import {
  zAutodeleteConfig,
  type AutodeleteConfig,
  type AutodeleteRule,
} from "../../../config/schemas/autodelete.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import type { ChannelScopeSource } from "../../../core/channelMatch.js";

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

/**
 * The rule for a message's channel. A rule's channel may also be a category, covering every
 * channel in it (including ones made later); a rule set on the channel itself wins over its
 * category's. Thread messages only match a rule set on that exact thread, as before.
 */
export function autodeleteRuleFor(
  config: AutodeleteConfig,
  channel: ChannelScopeSource & { isThread?: () => boolean },
): AutodeleteRule | undefined {
  const rules = autodeleteRuleByChannel(config);
  const exact = rules.get(channel.id);
  if (exact || channel.isThread?.() || !channel.parentId) return exact;
  return rules.get(channel.parentId);
}
