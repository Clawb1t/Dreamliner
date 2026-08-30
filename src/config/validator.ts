import YAML from "yaml";
import { ZodIssueCode, type ZodIssue } from "zod";
import { zGuildConfig, type GuildConfig } from "./schemas/guild.js";
import { zUtilityConfig } from "./schemas/utility.js";
import { loadDefaultConfig } from "./default.js";
import { migrateAutomodAndCensorInConfig } from "../plugins/automod/functions/migrate.js";
import { migrateWelcomeMessageInConfig } from "./schemas/welcome.js";
import { migrateCompanionChannelsInConfig } from "./schemas/companion.js";
import { scrubUnknownPluginConfigKeys } from "../core/pluginSchemas.js";
import { validateRegexPatternSync } from "../core/regexSafety.js";

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
/** Rename legacy leaderboard_accent_color → server_accent_color. */
function migrateServerAccentColor(config: Record<string, unknown>): boolean {
  const legacy = config.leaderboard_accent_color;
  const hasLegacy = typeof legacy === "number" && Number.isFinite(legacy);
  if (hasLegacy && config.server_accent_color == null) {
    config.server_accent_color = legacy;
  }
  if ("leaderboard_accent_color" in config) {
    delete config.leaderboard_accent_color;
    return true;
  }
  return hasLegacy;
}

export function repairGuildConfig(raw: unknown): {
  success: true;
  data: GuildConfig;
  repairs: string[];
} | { success: false; errors: string[] } {
  const defaults = loadDefaultConfig() as unknown as Record<string, unknown>;
  const override = isPlainObject(raw) ? cloneJson(raw) : {};
  const repairs: string[] = [];
  if (isPlainObject(override) && migrateServerAccentColor(override)) {
    repairs.push("server_accent_color (migrated from leaderboard_accent_color)");
  }
  let value = deepMerge(defaults, override);
  const seen = new Set<string>();

  if (migrateAutomodAndCensorInConfig(value)) {
    repairs.push("plugins.automod (migrated from legacy automod/censor)");
  }

  if (migrateWelcomeMessageInConfig(value)) {
    repairs.push("plugins.welcome_message (migrated to join/leave/dm welcomer)");
  }

  if (migrateCompanionChannelsInConfig(value)) {
    repairs.push("plugins.companion_channels (migrated to dashboard join-to-create setups)");
  }

  repairs.push(...scrubUnknownPluginConfigKeys(value));

  if (migrateServerAccentColor(value) && !repairs.some((r) => r.includes("server_accent_color"))) {
    repairs.push("server_accent_color (migrated from leaderboard_accent_color)");
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
      // Last resort for stubborn sections: reset the whole top-level key back to
      // its default value (a plugin section if the issue is under plugins.<name>,
      // otherwise the top-level field itself — levels, emojis, etc). Every default
      // field validates on its own, so this always makes forward progress.
      for (const issue of parsed.error.issues) {
        if (issue.path.length === 0) continue;
        const topKey = String(issue.path[0]);
        const isPluginSection = topKey === "plugins" && issue.path.length > 1;
        const pluginKey = isPluginSection ? String(issue.path[1]) : undefined;
        const label = isPluginSection ? `plugins.${pluginKey}` : topKey;
        if (seen.has(`${label}#section-reset`)) continue;

        if (isPluginSection && pluginKey) {
          const defaultSection = getAtPath(defaults, ["plugins", pluginKey]);
          const plugins = getAtPath(value, ["plugins"]);
          if (!isPlainObject(plugins)) continue;
          if (defaultSection === undefined) {
            delete plugins[pluginKey];
          } else {
            plugins[pluginKey] = cloneJson(defaultSection);
          }
        } else {
          const container = value as Record<string, unknown>;
          const defaultTop = defaults[topKey];
          if (defaultTop === undefined) {
            delete container[topKey];
          } else {
            container[topKey] = cloneJson(defaultTop);
          }
        }

        seen.add(`${label}#section-reset`);
        repairs.push(`${label} (reset to defaults)`);
        changed = true;
        break;
      }
    }

    if (!changed) break;

    // Re-fill any required structure removed while repairing.
    value = deepMerge(defaults, value as Record<string, unknown>);
  }

  // Guaranteed convergence: defaults validate cleanly on their own (checked at
  // startup), so if every targeted repair pass above still couldn't produce a
  // valid config, fall all the way back to a clean default config rather than
  // leaving the guild permanently stuck failing validation on every read.
  const finalAttempt = zGuildConfig.safeParse(value);
  if (finalAttempt.success) {
    return { success: true, data: finalAttempt.data, repairs };
  }

  const fallback = zGuildConfig.safeParse(defaults);
  if (fallback.success) {
    return {
      success: true,
      data: fallback.data,
      repairs: [...repairs, "(full reset — config could not be repaired safely, restored to defaults)"],
    };
  }

  return {
    success: false,
    errors: finalAttempt.success ? [] : finalAttempt.error.issues.map((i) => `${pathLabel(i.path)}: ${i.message}`),
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

  const prepared = isPlainObject(raw) ? cloneJson(raw) : raw;
  if (isPlainObject(prepared)) {
    migrateServerAccentColor(prepared);
  }
  const result = zGuildConfig.safeParse(prepared);
  if (!result.success) {
    return {
      success: false,
      errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  return { success: true, data: result.data };
}

/**
 * Scan the config for all regex patterns and validate them against ReDoS attacks.
 * Returns error messages for any unsafe patterns found.
 */
function validateConfigRegexPatterns(config: GuildConfig): string[] {
  const errors: string[] = [];

  // Check autoreactions
  if (config.plugins.autoreactions?.config?.rules) {
    for (const rule of config.plugins.autoreactions.config.rules) {
      if (rule && typeof rule === "object" && "trigger" in rule && "match" in rule) {
        const r = rule as { trigger?: string; match?: string };
        if (r.trigger === "regex" && r.match) {
          const validation = validateRegexPatternSync(r.match, "i");
          if (!validation.ok) {
            errors.push(`plugins.autoreactions: ${validation.error}`);
          }
        }
      }
    }
  }

  // Check autoreplies
  if (config.plugins.autoreplies?.config?.rules) {
    for (const rule of config.plugins.autoreplies.config.rules) {
      if (rule && typeof rule === "object" && "trigger" in rule && "match" in rule) {
        const r = rule as { trigger?: string; match?: string };
        if (r.trigger === "regex" && r.match) {
          const validation = validateRegexPatternSync(r.match, "i");
          if (!validation.ok) {
            errors.push(`plugins.autoreplies: ${validation.error}`);
          }
        }
      }
    }
  }

  // Check autothreads
  if (config.plugins.autothreads?.config?.rules) {
    for (const rule of config.plugins.autothreads.config.rules) {
      if (rule && typeof rule === "object" && "trigger" in rule && "match" in rule) {
        const r = rule as { trigger?: string; match?: string };
        if (r.trigger === "regex" && r.match) {
          const validation = validateRegexPatternSync(r.match, "i");
          if (!validation.ok) {
            errors.push(`plugins.autothreads: ${validation.error}`);
          }
        }
      }
    }
  }

  // Check automod custom filters
  if (config.plugins.automod?.config?.rules?.custom_filter?.settings) {
    const settings = config.plugins.automod.config.rules.custom_filter.settings as Record<string, unknown>;
    for (const [key, entry] of Object.entries(settings)) {
      if (entry && typeof entry === "object" && "pattern" in entry && "regex" in entry) {
        const e = entry as { pattern?: string; regex?: boolean };
        if (e.regex && e.pattern) {
          const validation = validateRegexPatternSync(e.pattern, "i");
          if (!validation.ok) {
            errors.push(`plugins.automod custom_filter[${key}]: ${validation.error}`);
          }
        }
      }
    }
  }

  return errors;
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

  // Validate all regex patterns for ReDoS safety
  const regexErrors = validateConfigRegexPatterns(validated.data);
  if (regexErrors.length > 0) {
    return { success: false, errors: regexErrors };
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
