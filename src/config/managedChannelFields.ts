/**
 * Settings that make Dreamliner create channels in, or rename, a channel or category the manager
 * picks: counters that rename a channel, Companion Channels hubs and categories (temporary rooms
 * are created there), and ticket categories (ticket channels are created there). In Discord that
 * needs Manage Channels, so whoever newly points one of these at a channel must have it. Checked on
 * every config save (ConfigManager.saveGuildConfig), for newly added ids only.
 *
 * Exported in `schema/guild-config.meta.json` (`managedChannelFields`).
 *
 * Paths are `<plugin>.<path inside plugins.<plugin>.config>`; `*` stands for any key or index.
 */
export const MANAGED_CHANNEL_FIELDS = [
  // counters/functions/handlers.ts renames the channel (channel_name / voice_name displays only)
  "counters.counters.*.channel_id",
  // companion_channels/functions/rooms.ts creates temporary rooms from the hub, in the category
  "companion_channels.setups.*.hub_channel_id",
  "companion_channels.setups.*.category_id",
  // tickets/functions/channels.ts creates ticket channels under the category
  "tickets.panels.*.categories.*.category_channel_id",
] as const;

const SNOWFLAKE = /^\d{15,25}$/;

/** Entries whose field only matters in some modes (counters that just post a message don't rename). */
function applies(field: string, parent: Record<string, unknown>): boolean {
  if (field === "counters.counters.*.channel_id") return parent.display !== "message" && parent.display !== undefined;
  return true;
}

function walk(field: string, value: unknown, parts: string[], parent: Record<string, unknown>, out: Set<string>): void {
  if (value === null || value === undefined) return;
  if (!parts.length) {
    if (typeof value === "string" && SNOWFLAKE.test(value.trim()) && applies(field, parent)) out.add(value.trim());
    return;
  }
  const [head, ...rest] = parts;
  if (head === "*") {
    const children = Array.isArray(value) ? value : typeof value === "object" ? Object.values(value as Record<string, unknown>) : [];
    for (const child of children) walk(field, child, rest, (child ?? {}) as Record<string, unknown>, out);
    return;
  }
  if (typeof value !== "object" || Array.isArray(value)) return;
  const obj = value as Record<string, unknown>;
  walk(field, obj[head!], rest, obj, out);
}

/** Every channel id a config has in a managed-channel field. */
export function collectManagedChannelIds(config: unknown): Set<string> {
  const out = new Set<string>();
  const plugins = config && typeof config === "object" ? (config as { plugins?: Record<string, { config?: unknown }> }).plugins : undefined;
  if (!plugins || typeof plugins !== "object") return out;
  for (const field of MANAGED_CHANNEL_FIELDS) {
    const [plugin, ...path] = field.split(".");
    const root = plugins[plugin!]?.config;
    walk(field, root, path, (root ?? {}) as Record<string, unknown>, out);
  }
  return out;
}

/** Managed channel ids in `next` that weren't in `previous`. */
export function addedManagedChannelIds(previous: unknown, next: unknown): string[] {
  const before = collectManagedChannelIds(previous);
  return [...collectManagedChannelIds(next)].filter((id) => !before.has(id));
}
