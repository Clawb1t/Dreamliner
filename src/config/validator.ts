import YAML from "yaml";
import { zGuildConfig, type GuildConfig } from "./schemas/guild.js";
import { zUtilityConfig } from "./schemas/utility.js";
import { loadDefaultConfig } from "./default.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function validateGuildConfig(raw: unknown): { success: true; data: GuildConfig } | { success: false; errors: string[] } {
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

  const merged = deepMerge(loadDefaultConfig() as unknown as Record<string, unknown>, (parsed ?? {}) as Record<string, unknown>);
  const validated = validateGuildConfig(merged);
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
  const validated = validateGuildConfig(merged);
  if (!validated.success) {
    return validated;
  }
  return {
    success: true,
    data: validated.data,
    mergedYaml: YAML.stringify(validated.data),
  };
}
