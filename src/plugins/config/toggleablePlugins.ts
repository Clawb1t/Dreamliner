import { pluginConfigSchemas } from "../../core/pluginSchemas.js";

/** Plugin names that can be enabled/disabled via `/plugin toggle`. */
export const TOGGLEABLE_PLUGINS = Object.keys(pluginConfigSchemas).sort();

export function formatPluginLabel(pluginName: string): string {
  return pluginName
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function isToggleablePlugin(name: string): boolean {
  return name in pluginConfigSchemas;
}

export function autocompleteToggleablePlugins(
  query: string,
  limit = 25,
): { name: string; value: string }[] {
  const q = query.trim().toLowerCase();
  const matches = TOGGLEABLE_PLUGINS.filter((plugin) => {
    if (!q) return true;
    return plugin.includes(q) || formatPluginLabel(plugin).toLowerCase().includes(q);
  });

  return matches.slice(0, limit).map((plugin) => ({
    name: formatPluginLabel(plugin),
    value: plugin,
  }));
}
