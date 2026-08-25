import { zCountersConfig, type CounterEntry, type CountersConfig } from "../../../config/schemas/counters.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";
import { resolvePluginConfig } from "../../../core/permissions.js";
import { normalizeCounterName } from "./store.js";

export function loadCountersConfig(guildConfig: GuildConfig): CountersConfig {
  return parsePluginConfig(zCountersConfig, resolvePluginConfig(guildConfig, "counters"));
}

/** Enabled counters with a channel set, keyed by normalized name. Last enabled entry
 * wins when two share a name (mirrors persist's channel dedupe). */
export function countersByName(config: CountersConfig): Map<string, CounterEntry> {
  const map = new Map<string, CounterEntry>();
  for (const entry of config.counters) {
    const name = normalizeCounterName(entry.name);
    if (!name || entry.enabled === false || !entry.channel_id.trim()) continue;
    map.set(name, { ...entry, name, channel_id: entry.channel_id.trim() });
  }
  return map;
}
