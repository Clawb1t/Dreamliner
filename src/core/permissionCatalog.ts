import { ZodObject } from "zod";
import { pluginConfigSchemas } from "./pluginSchemas.js";
import { PLUGIN_DISPLAY } from "./helpCategories.js";
import { defaultPermissionDescription, humanizeKey } from "../config/schemaHelp.js";

// The permission catalog every Dreamliner Role's grant grid is built from — one `can_*` zod
// field per plugin config schema is one entry. Schema-introspected rather than hand-maintained:
// a plugin's `can_*` flags live in exactly one place already (its zod config schema, via
// boolPerm()), so walking that schema can't drift from what's actually gate-able the way a
// separately hand-maintained list could. Grouped by plugin, using the same display names shown
// in `/help` and the website editor sidebar (PLUGIN_DISPLAY).

export type PermissionCatalogEntry = {
  plugin: string;
  permission: string;
  /** `<plugin>.<permission>` — the grant key stored on a Dreamliner Role. */
  grantKey: string;
  title: string;
  description: string;
};

export type PermissionCatalogGroup = {
  plugin: string;
  pluginName: string;
  pluginDescription: string;
  entries: PermissionCatalogEntry[];
};

export function grantKeyFor(plugin: string, permission: string): string {
  return `${plugin}.${permission}`;
}

let cachedCatalog: PermissionCatalogGroup[] | null = null;

/** Every `can_*` flag across every plugin, grouped by plugin. Built once and cached — the schemas it walks are static module-level definitions. */
export function getPermissionCatalog(): PermissionCatalogGroup[] {
  if (cachedCatalog) return cachedCatalog;

  const groups: PermissionCatalogGroup[] = [];
  for (const [plugin, schema] of Object.entries(pluginConfigSchemas)) {
    if (!(schema instanceof ZodObject)) continue;
    const shape = schema.shape as Record<string, { description?: string }>;
    const entries: PermissionCatalogEntry[] = [];
    for (const [key, field] of Object.entries(shape)) {
      if (!key.startsWith("can_")) continue;
      entries.push({
        plugin,
        permission: key,
        grantKey: grantKeyFor(plugin, key),
        title: humanizeKey(key),
        description: field.description || defaultPermissionDescription(key),
      });
    }
    if (entries.length === 0) continue;
    entries.sort((a, b) => a.title.localeCompare(b.title));
    const display = PLUGIN_DISPLAY[plugin];
    groups.push({
      plugin,
      pluginName: display?.name ?? humanizeKey(plugin),
      pluginDescription: display?.description ?? "",
      entries,
    });
  }

  groups.sort((a, b) => a.pluginName.localeCompare(b.pluginName));
  cachedCatalog = groups;
  return groups;
}

/** Every valid grant key, for validating a role's stored grants (e.g. against a stale/renamed permission). */
export function getAllGrantKeys(): Set<string> {
  const keys = new Set<string>();
  for (const group of getPermissionCatalog()) {
    for (const entry of group.entries) keys.add(entry.grantKey);
  }
  return keys;
}

export function findPermissionCatalogEntry(grantKey: string): PermissionCatalogEntry | undefined {
  for (const group of getPermissionCatalog()) {
    const found = group.entries.find((e) => e.grantKey === grantKey);
    if (found) return found;
  }
  return undefined;
}
