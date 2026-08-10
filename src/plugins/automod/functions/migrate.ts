import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  AUTOMOD_RULE_IDS,
  zAutomodConfig,
  type AutomodConfig,
  type AutomodFilterEntry,
  type AutomodRuleConfig,
} from "../../../config/schemas/automod.js";
import { getDb } from "../../../db/client.js";
import { censorRules } from "../../../db/schema.js";
import { defaultAutomodRules } from "./presets.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function legacyActionToLadder(
  action: unknown,
  muteDurationMs: unknown,
): AutomodRuleConfig["ladder"] {
  const muteMs = typeof muteDurationMs === "number" && muteDurationMs > 0 ? muteDurationMs : 600_000;
  if (action === "warn") {
    return [{ after: 1, actions: [{ type: "delete" }, { type: "warn" }] }];
  }
  if (action === "mute") {
    return [{ after: 1, actions: [{ type: "delete" }, { type: "mute", duration_ms: muteMs }] }];
  }
  return [{ after: 1, actions: [{ type: "delete" }] }];
}

function ensureRuleBase(rules: Record<string, AutomodRuleConfig>): Record<string, AutomodRuleConfig> {
  const out = { ...defaultAutomodRules(), ...rules };
  for (const id of AUTOMOD_RULE_IDS) {
    if (!out[id]) out[id] = defaultAutomodRules()[id]!;
  }
  return out;
}

/** Migrate legacy automod YAML keys into the new rules model (in-place on plugins object). */
export function migrateLegacyAutomodInPlugins(plugins: Record<string, unknown>): boolean {
  const automod = plugins.automod;
  if (!isPlainObject(automod)) return false;
  const config = isPlainObject(automod.config) ? automod.config : null;
  if (!config) return false;

  const migrations = isPlainObject(config.migrations) ? config.migrations : {};
  if (migrations.legacy_v1 === true) return false;
  if (!("enabled_rules" in config) && !("action" in config) && !("duplicate_max" in config)) {
    config.migrations = { ...migrations, legacy_v1: true };
    return true;
  }

  const enabledRules = Array.isArray(config.enabled_rules)
    ? config.enabled_rules.map(String)
    : ["duplicate", "rate_limit"];
  const ladder = legacyActionToLadder(config.action, config.mute_duration_ms);
  const rules = ensureRuleBase(
    isPlainObject(config.rules) ? (config.rules as Record<string, AutomodRuleConfig>) : {},
  );

  if (enabledRules.includes("duplicate")) {
    rules.duplicate = {
      ...rules.duplicate!,
      enabled: true,
      strike_window_ms:
        typeof config.duplicate_window_ms === "number" ? config.duplicate_window_ms : 30_000,
      ladder,
      settings: {
        ...rules.duplicate!.settings,
        max: typeof config.duplicate_max === "number" ? config.duplicate_max : 3,
        window_ms: typeof config.duplicate_window_ms === "number" ? config.duplicate_window_ms : 30_000,
      },
    };
  }

  if (enabledRules.includes("rate_limit")) {
    rules.spam = {
      ...rules.spam!,
      enabled: true,
      strike_window_ms:
        typeof config.rate_limit_window_ms === "number" ? config.rate_limit_window_ms : 10_000,
      ladder,
      settings: {
        ...rules.spam!.settings,
        count: typeof config.rate_limit_count === "number" ? config.rate_limit_count : 5,
        window_ms: typeof config.rate_limit_window_ms === "number" ? config.rate_limit_window_ms : 10_000,
      },
    };
  }

  if (enabledRules.includes("raid")) {
    rules.raid = {
      ...rules.raid!,
      enabled: true,
      ladder: [{ after: 1, actions: [{ type: "note" }] }],
      settings: {
        ...rules.raid!.settings,
        join_count: typeof config.raid_join_count === "number" ? config.raid_join_count : 10,
        join_window_ms:
          typeof config.raid_join_window_ms === "number" ? config.raid_join_window_ms : 30_000,
      },
    };
  }

  config.rules = rules;
  config.dm_users = typeof config.dm_users === "boolean" ? config.dm_users : true;
  config.migrations = { ...migrations, legacy_v1: true };

  delete config.enabled_rules;
  delete config.duplicate_window_ms;
  delete config.duplicate_max;
  delete config.rate_limit_count;
  delete config.rate_limit_window_ms;
  delete config.raid_join_count;
  delete config.raid_join_window_ms;
  delete config.action;
  delete config.mute_duration_ms;

  return true;
}

/** Fold plugins.censor + censor_rules rows into automod.custom_filter (sync portion). */
export function migrateCensorYamlInPlugins(plugins: Record<string, unknown>): boolean {
  const censor = plugins.censor;
  const automod = isPlainObject(plugins.automod) ? plugins.automod : { enabled: false, config: {} };
  if (!isPlainObject(plugins.automod)) plugins.automod = automod;

  const config = isPlainObject(automod.config) ? automod.config : {};
  automod.config = config;
  const migrations = isPlainObject(config.migrations) ? config.migrations : {};
  if (migrations.censor_v1 === true) {
    if ("censor" in plugins) {
      delete plugins.censor;
      return true;
    }
    return false;
  }

  const rules = ensureRuleBase(
    isPlainObject(config.rules) ? (config.rules as Record<string, AutomodRuleConfig>) : {},
  );

  const censorConfig = isPlainObject(censor) && isPlainObject(censor.config) ? censor.config : {};
  const yamlRules = Array.isArray(censorConfig.rules) ? censorConfig.rules : [];
  const entries: AutomodFilterEntry[] = [];
  let hadWarn = false;

  for (const raw of yamlRules) {
    if (!isPlainObject(raw) || typeof raw.pattern !== "string" || !raw.pattern.trim()) continue;
    if (raw.action === "warn") hadWarn = true;
    entries.push({
      id: randomUUID(),
      pattern: raw.pattern,
      regex: Boolean(raw.regex),
      enabled: true,
    });
  }

  const censorEnabled = isPlainObject(censor) ? censor.enabled !== false : false;
  rules.custom_filter = {
    ...rules.custom_filter!,
    enabled: censorEnabled && (entries.length > 0 || yamlRules.length > 0),
    ladder: hadWarn
      ? [{ after: 1, actions: [{ type: "delete" }, { type: "warn" }] }]
      : [{ after: 1, actions: [{ type: "delete" }] }],
    settings: {
      ...rules.custom_filter!.settings,
      entries: [
        ...(Array.isArray(rules.custom_filter!.settings.entries)
          ? (rules.custom_filter!.settings.entries as AutomodFilterEntry[])
          : []),
        ...entries,
      ],
    },
  };

  const ignoreChannels = Array.isArray(censorConfig.ignored_channels)
    ? censorConfig.ignored_channels.map(String)
    : [];
  const existingIgnores = Array.isArray(config.ignored_channels)
    ? config.ignored_channels.map(String)
    : [];
  config.ignored_channels = [...new Set([...existingIgnores, ...ignoreChannels])];
  config.rules = rules;
  config.migrations = { ...migrations, censor_v1: true };

  delete plugins.censor;
  return true;
}

export async function mergeCensorDbRulesIntoConfig(
  guildId: string,
  config: AutomodConfig,
): Promise<AutomodConfig> {
  if (config.migrations?.censor_db_v1) return config;

  let rows: Array<{ pattern: string; regex: boolean; action: string }> = [];
  try {
    rows = await getDb().select().from(censorRules).where(eq(censorRules.guildId, guildId)).all();
  } catch {
    return {
      ...config,
      migrations: { ...config.migrations, censor_db_v1: true },
    };
  }

  if (!rows.length) {
    return {
      ...config,
      migrations: { ...config.migrations, censor_db_v1: true },
    };
  }

  const existing = Array.isArray(config.rules.custom_filter?.settings?.entries)
    ? ([...config.rules.custom_filter!.settings.entries] as AutomodFilterEntry[])
    : [];
  const seen = new Set(existing.map((e) => `${e.regex ? "r" : "l"}:${e.pattern.toLowerCase()}`));
  let hadWarn = config.rules.custom_filter?.ladder.some((s) =>
    s.actions.some((a) => a.type === "warn"),
  );

  for (const row of rows) {
    const key = `${row.regex ? "r" : "l"}:${row.pattern.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.action === "warn") hadWarn = true;
    existing.push({
      id: randomUUID(),
      pattern: row.pattern,
      regex: row.regex,
      enabled: true,
    });
  }

  const custom = {
    ...config.rules.custom_filter!,
    enabled: Boolean(config.rules.custom_filter?.enabled) || existing.length > 0,
    ladder: hadWarn
      ? [{ after: 1, actions: [{ type: "delete" as const }, { type: "warn" as const }] }]
      : (config.rules.custom_filter?.ladder ?? [{ after: 1, actions: [{ type: "delete" as const }] }]),
    settings: {
      ...config.rules.custom_filter?.settings,
      entries: existing,
    },
  };

  return {
    ...config,
    rules: { ...config.rules, custom_filter: custom },
    migrations: { ...config.migrations, censor_db_v1: true },
  };
}

/** Run YAML-level automod/censor migrations before schema validation. */
export function migrateAutomodAndCensorInConfig(raw: unknown): boolean {
  if (!isPlainObject(raw)) return false;
  const plugins = raw.plugins;
  if (!isPlainObject(plugins)) return false;
  const a = migrateLegacyAutomodInPlugins(plugins);
  const b = migrateCensorYamlInPlugins(plugins);
  return a || b;
}

export function parseAutomodConfig(raw: unknown): AutomodConfig {
  const parsed = zAutomodConfig.parse(raw ?? {});
  return {
    ...parsed,
    rules: ensureRuleBase(parsed.rules as Record<string, AutomodRuleConfig>),
  };
}
