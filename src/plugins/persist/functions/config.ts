import { zPersistConfig, type PersistConfig, type PersistSticky } from "../../../config/schemas/persist.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import { resolvePluginConfig } from "../../../core/permissions.js";
import { stickyHasContent } from "./messageBuilder.js";

export function loadPersistConfig(guildConfig: GuildConfig): PersistConfig {
  return parsePluginConfig(zPersistConfig, resolvePluginConfig(guildConfig, "persist"));
}

/** Last matching enabled entry wins when two stickies share a channel. */
export function stickyByChannel(config: PersistConfig): Map<string, PersistSticky> {
  const map = new Map<string, PersistSticky>();
  for (const message of config.messages) {
    const channelId = message.channel_id.trim();
    if (!channelId || message.enabled === false || !stickyHasContent(message)) continue;
    map.set(channelId, { ...message, channel_id: channelId });
  }
  return map;
}
