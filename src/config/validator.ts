import YAML from "yaml";
import { ZodIssueCode, type ZodIssue } from "zod";
import { zGuildConfig, type GuildConfig } from "./schemas/guild.js";
import { zUtilityConfig } from "./schemas/utility.js";
import { loadDefaultConfig } from "./default.js";
import { migrateAutomodAndCensorInConfig } from "../plugins/automod/functions/migrate.js";
import { migrateWelcomeMessageInConfig } from "./schemas/welcome.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function getAtPath(root: unknown, path: (string | number)[]): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (!isPlainObject(cursor) && !Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string | number, unknown>)[segment];
  }
  return cursor;
}

/** Delete a leaf value (object key or array index) at path. */
function deletePath(root: unknown, path: (string | number)[]): boolean {
  if (path.length === 0) return false;
  const key = path[path.length - 1]!;
  const parent = path.length === 1 ? root : getAtPath(root, path.slice(0, -1));
  if (Array.isArray(parent) && typeof key === "number") {
    if (key < 0 || key >= parent.length) return false;
    parent.splice(key, 1);
    return true;
  }
  if (isPlainObject(parent) && Object.prototype.hasOwnProperty.call(parent, String(key))) {
    delete parent[String(key)];
    return true;
  }
  return false;
}

function pathLabel(path: (string | number)[]): string {
  return path.map(String).join(".");
}

function issueRepairs(issue: ZodIssue): { path: (string | number)[]; label: string }[] {
  if (issue.code === ZodIssueCode.unrecognized_keys) {
    return issue.keys.map((key) => ({
      path: [...issue.path, key],
      label: pathLabel([...issue.path, key]),
    }));
  }

  if (issue.path.length === 0) return [];

  // Prefer removing the invalid leaf. For array items that are wholly invalid,
  // Zod usually points at the item index which we can splice out.
  return [{ path: [...issue.path], label: pathLabel(issue.path) }];
}

/**
 * Repair a guild config in place against the current schema:
 * - fills missing structure from defaults
 * - strips obsolete/unknown keys
 * - removes or resets only invalid values/sections
 *
 * Never replaces the whole config with defaults when only part of it is broken.
 */
export function repairGuildConfig(raw: unknown): {
  success: true;
  data: GuildConfig;
  repairs: string[];
} | { success: false; errors: string[] } {
  const defaults = loadDefaultConfig() as unknown as Record<string, unknown>;
  const override = isPlainObject(raw) ? cloneJson(raw) : {};
  let value = deepMerge(defaults, override);
  const repairs: string[] = [];
  const seen = new Set<string>();

  if (migrateAutomodAndCensorInConfig(value)) {
    repairs.push("plugins.automod (migrated from legacy automod/censor)");
  }

  if (migrateWelcomeMessageInConfig(value)) {
    repairs.push("plugins.welcome_message (migrated to join/leave/dm welcomer)");
  }

  for (let attempt = 0; attempt < 40; attempt++) {
    const parsed = zGuildConfig.safeParse(value);
    if (parsed.success) {
      return {
        success: true,
        data: parsed.data,
        repairs,
      };
    }

    let changed = false;
    for (const issue of parsed.error.issues) {
      for (const target of issueRepairs(issue)) {
        if (!target.path.length) continue;
        if (seen.has(`${target.label}#${issue.code}`)) continue;
        if (!deletePath(value, target.path)) continue;
        seen.add(`${target.label}#${issue.code}`);
        repairs.push(target.label);
        changed = true;
      }
    }

    if (!changed) {
      // Last resort for stubborn plugin sections: reset only the broken plugin.
      for (const issue of parsed.error.issues) {
        const pluginIdx = issue.path[0] === "plugins" ? 1 : -1;
        if (pluginIdx < 0 || issue.path.length < 2) continue;
        const pluginKey = String(issue.path[1]);
        const label = `plugins.${pluginKey}`;
        if (seen.has(`${label}#section-reset`)) continue;
        const defaultSection = getAtPath(defaults, ["plugins", pluginKey]);
        const plugins = getAtPath(value, ["plugins"]);
        if (!isPlainObject(plugins)) continue;
        if (defaultSection === undefined) {
          delete plugins[pluginKey];
        } else {
          plugins[pluginKey] = cloneJson(defaultSection);
        }
        seen.add(`${label}#section-reset`);
        repairs.push(`${label} (reset to defaults)`);
        changed = true;
        break;
      }
    }

    if (!changed) {
      return {
        success: false,
        errors: parsed.error.issues.map((i) => `${pathLabel(i.path)}: ${i.message}`),
      };
    }

    // Re-fill any required structure removed while repairing.
    value = deepMerge(defaults, value as Record<string, unknown>);
  }

  return {
    success: false,
    errors: ["Config repair exceeded the maximum number of passes."],
  };
}

/** @deprecated Prefer repairGuildConfig. Kept for callers that only want unknown-key stripping. */
export function stripUnrecognizedKeys(raw: unknown): {
  value: unknown;
  stripped: string[];
} {
  const repaired = repairGuildConfig(raw);
  if (repaired.success) {
    return { value: repaired.data, stripped: repaired.repairs };
  }
  return { value: cloneJson(raw), stripped: [] };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => deepEqual(a[key], b[key]));
}

/** Extract only values that differ from defaults (user customizations). */
export function computeUserOverrides(
  stored: unknown,
  defaults: unknown,
): Record<string, unknown> {
  if (deepEqual(stored, defaults)) return {};
  if (!isPlainObject(stored) || !isPlainObject(defaults)) {
    return deepEqual(stored, defaults) ? {} : { ...(stored as Record<string, unknown>) };
  }

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(stored)) {
    const storedVal = stored[key];
    const defaultVal = defaults[key];
    if (deepEqual(storedVal, defaultVal)) continue;
    if (isPlainObject(storedVal) && isPlainObject(defaultVal)) {
      const nested = computeUserOverrides(storedVal, defaultVal);
      if (Object.keys(nested).length > 0) {
        result[key] = nested;
      }
    } else {
      result[key] = storedVal;
    }
  }
  return result;
}

export function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const result = { ...base } as Record<string, unknown>;

  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

export function parseYamlConfig(yamlText: string): unknown {
  return YAML.parse(yamlText);
}

export function validateGuildConfig(
  raw: unknown,
  options?: { stripUnknown?: boolean; repair?: boolean },
):
  | { success: true; data: GuildConfig; strippedKeys?: string[]; repairs?: string[] }
  | { success: false; errors: string[] } {
  const shouldRepair = options?.repair ?? options?.stripUnknown ?? false;
  if (shouldRepair) {
    const repaired = repairGuildConfig(raw);
    if (!repaired.success) return repaired;
    return {
      success: true,
      data: repaired.data,
      ...(repaired.repairs.length > 0
        ? { strippedKeys: repaired.repairs, repairs: repaired.repairs }
        : {}),
    };
  }

  const result = zGuildConfig.safeParse(raw);
  if (!result.success) {
    return {
      success: false,
      errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  return { success: true, data: result.data };
}

export function validateMergedConfig(userYaml: string): { success: true; data: GuildConfig; mergedYaml: string } | { success: false; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = parseYamlConfig(userYaml);
  } catch (e) {
    return { success: false, errors: [`Invalid YAML: ${e instanceof Error ? e.message : String(e)}`] };
  }

  const merged = deepMerge(
    loadDefaultConfig() as unknown as Record<string, unknown>,
    (parsed ?? {}) as Record<string, unknown>,
  );
  // On save: repair obsolete/invalid fragments so schema evolution cannot block saves,
  // while preserving every valid customization.
  const validated = validateGuildConfig(merged, { repair: true });
  if (!validated.success) {
    return validated;
  }

  return {
    success: true,
    data: validated.data,
    mergedYaml: YAML.stringify(validated.data),
  };
}

export function getUtilityConfig(guildConfig: GuildConfig) {
  const section = guildConfig.plugins.utility;
  const base = zUtilityConfig.parse({});
  const userConfig = section?.config ?? {};
  return { ...base, ...userConfig };
}

export function mergeConfigWithDefaults(
  userOverrides: Record<string, unknown>,
): { success: true; data: GuildConfig; mergedYaml: string } | { success: false; errors: string[] } {
  const merged = deepMerge(loadDefaultConfig() as unknown as Record<string, unknown>, userOverrides);
  const validated = validateGuildConfig(merged, { repair: true });
  if (!validated.success) {
    return validated;
  }
  return {
    success: true,
    data: validated.data,
    mergedYaml: YAML.stringify(validated.data),
  };
}
