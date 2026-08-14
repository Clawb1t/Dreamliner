import { eq } from "drizzle-orm";
import YAML from "yaml";

import { getDb } from "../db/client.js";
import { guildConfigs } from "../db/schema.js";
import { clearDefaultConfigCache, loadDefaultConfig, loadDefaultConfigRaw } from "./default.js";
import {
  computeUserOverrides,
  deepMerge,
  mergeConfigWithDefaults,
  parseYamlConfig,
  validateGuildConfig,
  validateMergedConfig,
} from "./validator.js";
import type { GuildConfig } from "./schemas/guild.js";
import type { ConfigOverride } from "../core/types.js";
import { migrateLegacyEmojis, migrateLegacyEmojisInObject } from "./emojiMigration.js";

const cache = new Map<string, GuildConfig>();

type SaveResult = { success: true; data: GuildConfig } | { success: false; errors: string[] };

function isPermissionOverrideMatch(
  override: ConfigOverride,
  target: { user?: string; role?: string },
): boolean {
  if (override.level || override.channel || override.category) return false;
  if (target.user) return override.user === target.user && !override.role;
  if (target.role) return override.role === target.role && !override.user;
  return false;
}

type ConfigSaveListener = (guildId: string, config: GuildConfig) => void;

export class ConfigManager {
  private saveListeners = new Set<ConfigSaveListener>();

  onSave(listener: ConfigSaveListener): () => void {
    this.saveListeners.add(listener);
    return () => {
      this.saveListeners.delete(listener);
    };
  }

  private notifySave(guildId: string, config: GuildConfig): void {
    for (const listener of this.saveListeners) {
      try {
        listener(guildId, config);
      } catch (error) {
        console.error("[dreamliner] Config save listener failed:", error);
      }
    }
  }

  async getGuildConfig(guildId: string): Promise<GuildConfig | null> {
    if (cache.has(guildId)) {
      return cache.get(guildId)!;
    }

    const db = getDb();
    const row = await db.select().from(guildConfigs).where(eq(guildConfigs.guildId, guildId)).get();
    if (!row) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = YAML.parse(row.configYaml);
    } catch (error) {
      console.error(
        `[dreamliner] Invalid guild config YAML for ${guildId}:`,
        error instanceof Error ? error.message : error,
      );
      parsed = null;
    }

    // Repair only broken fragments (obsolete keys / invalid values). Never wipe the whole guild config.
    let validated =
      parsed == null
        ? ({ success: false as const, errors: ["Config YAML could not be parsed."] })
        : validateGuildConfig(parsed, { repair: true });

    if (!validated.success && row.userConfigYaml) {
      try {
        const userOverrides = (parseYamlConfig(row.userConfigYaml) ?? {}) as Record<string, unknown>;
        const rebuilt = mergeConfigWithDefaults(userOverrides);
        if (rebuilt.success) {
          console.warn(
            `[dreamliner] Repaired guild config for ${guildId} from user overrides after snapshot repair failed:`,
            validated.errors,
          );
          validated = {
            success: true,
            data: rebuilt.data,
            strippedKeys: ["(repaired-from-user-overrides)"],
            repairs: ["(repaired-from-user-overrides)"],
          };
        }
      } catch (error) {
        console.error(
          `[dreamliner] Failed to repair guild config for ${guildId} from user overrides:`,
          error,
        );
      }
    }

    if (!validated.success) {
      console.error(
        `[dreamliner] Invalid guild config for ${guildId}; falling back to defaults until fixed. Errors:`,
        validated.errors,
      );
      return null;
    }

    const repairs = validated.repairs ?? validated.strippedKeys ?? [];
    if (repairs.length) {
      console.warn(
        `[dreamliner] Repaired guild config for ${guildId} (kept valid settings): ${repairs.join(", ")}`,
      );
    }

    const migratedEmojis = migrateLegacyEmojis(validated.data.emojis);
    const data: GuildConfig = migratedEmojis.changed
      ? { ...validated.data, emojis: migratedEmojis.emojis }
      : validated.data;

    cache.set(guildId, data);

    const shouldPersistCleanup = repairs.length > 0 || migratedEmojis.changed;
    if (shouldPersistCleanup) {
      void this.persistConfigCleanup(guildId, data, row.userConfigYaml, {
        emojiMigration: migratedEmojis.changed,
        strippedKeys: repairs,
      }).catch((error) => {
        console.error(`[dreamliner] Failed to persist config cleanup for ${guildId}:`, error);
      });
    }

    return data;
  }

  private async persistConfigCleanup(
    guildId: string,
    config: GuildConfig,
    userConfigYaml: string | null | undefined,
    reason: { emojiMigration: boolean; strippedKeys: string[] },
  ): Promise<void> {
    let nextUserConfigYaml = userConfigYaml ?? null;
    if (userConfigYaml) {
      try {
        const parsed = (parseYamlConfig(userConfigYaml) ?? {}) as Record<string, unknown>;
        let nextUser: unknown = parsed;
        if (reason.strippedKeys.length > 0) {
          const defaults = loadDefaultConfig() as unknown as Record<string, unknown>;
          const cleaned = validateGuildConfig(deepMerge(defaults, parsed), { repair: true });
          if (cleaned.success) {
            nextUser = computeUserOverrides(
              cleaned.data as unknown as Record<string, unknown>,
              defaults,
            );
          }
        }
        const migrated = migrateLegacyEmojisInObject(nextUser);
        nextUserConfigYaml = YAML.stringify(migrated.value);
      } catch {
        // Keep original user YAML if it cannot be parsed.
      }
    }

    const updatedBy = reason.emojiMigration
      ? "system:emoji-migration"
      : "system:config-cleanup";

    const db = getDb();
    await db
      .update(guildConfigs)
      .set({
        configYaml: YAML.stringify(config),
        userConfigYaml: nextUserConfigYaml,
        updatedAt: new Date(),
        updatedBy,
      })
      .where(eq(guildConfigs.guildId, guildId));

    if (reason.emojiMigration) {
      console.log(`[dreamliner] Migrated legacy response emojis for guild ${guildId}`);
    }
    if (reason.strippedKeys.length > 0) {
      console.log(`[dreamliner] Persisted repaired guild config for ${guildId}`);
    }
  }

  async getEffectiveConfig(guildId: string): Promise<GuildConfig> {
    const stored = await this.getGuildConfig(guildId);
    if (stored) return stored;
    console.warn(
      `[dreamliner] No valid stored config for guild ${guildId}; using default.server.yaml (custom settings are not applied until config loads successfully).`,
    );
    return loadDefaultConfig();
  }

  hasGuildConfig(guildId: string): boolean {
    return cache.has(guildId);
  }

  async saveGuildConfig(guildId: string, userYaml: string, updatedBy: string): Promise<SaveResult> {
    const result = validateMergedConfig(userYaml);
    if (!result.success) {
      return result;
    }

    const defaultsSnapshotYaml = loadDefaultConfigRaw();
    let userConfigYaml = userYaml;
    try {
      const parsed = parseYamlConfig(userYaml);
      userConfigYaml = YAML.stringify(parsed ?? {});
    } catch {
      userConfigYaml = userYaml;
    }

    const db = getDb();
    await db
      .insert(guildConfigs)
      .values({
        guildId,
        configYaml: result.mergedYaml,
        userConfigYaml,
        defaultsSnapshotYaml,
        updatedAt: new Date(),
        updatedBy,
      })
      .onConflictDoUpdate({
        target: guildConfigs.guildId,
        set: {
          configYaml: result.mergedYaml,
          userConfigYaml,
          defaultsSnapshotYaml,
          updatedAt: new Date(),
          updatedBy,
        },
      });

    cache.set(guildId, result.data);
    this.notifySave(guildId, result.data);
    return { success: true, data: result.data };
  }

  async updateGuildConfigFromDefaults(
    guildId: string,
    updatedBy: string,
  ): Promise<
    | { success: true; data: GuildConfig; usedLegacyDiff: boolean }
    | { success: false; errors: string[]; noConfig?: boolean }
  > {
    clearDefaultConfigCache();
    const db = getDb();
    const row = await db.select().from(guildConfigs).where(eq(guildConfigs.guildId, guildId)).get();
    if (!row) {
      return { success: false, errors: ["No configuration stored for this server. Use `/config upload` first."], noConfig: true };
    }

    let userOverrides: Record<string, unknown>;
    let usedLegacyDiff = false;

    if (row.userConfigYaml) {
      try {
        userOverrides = (parseYamlConfig(row.userConfigYaml) ?? {}) as Record<string, unknown>;
      } catch (e) {
        return { success: false, errors: [`Invalid stored user config: ${e instanceof Error ? e.message : String(e)}`] };
      }
    } else if (row.defaultsSnapshotYaml) {
      try {
        const stored = YAML.parse(row.configYaml) as Record<string, unknown>;
        const oldDefaults = YAML.parse(row.defaultsSnapshotYaml) as Record<string, unknown>;
        userOverrides = computeUserOverrides(stored, oldDefaults);
        usedLegacyDiff = true;
      } catch (e) {
        return { success: false, errors: [`Failed to compute overrides: ${e instanceof Error ? e.message : String(e)}`] };
      }
    } else {
      try {
        const stored = YAML.parse(row.configYaml) as Record<string, unknown>;
        const oldDefaults = loadDefaultConfig() as unknown as Record<string, unknown>;
        userOverrides = computeUserOverrides(stored, oldDefaults);
        usedLegacyDiff = true;
      } catch (e) {
        return { success: false, errors: [`Failed to compute overrides: ${e instanceof Error ? e.message : String(e)}`] };
      }
    }

    const result = mergeConfigWithDefaults(userOverrides);
    if (!result.success) {
      return result;
    }

    const defaultsSnapshotYaml = loadDefaultConfigRaw();
    const userConfigYaml = YAML.stringify(userOverrides);

    await db
      .update(guildConfigs)
      .set({
        configYaml: result.mergedYaml,
        userConfigYaml,
        defaultsSnapshotYaml,
        updatedAt: new Date(),
        updatedBy,
      })
      .where(eq(guildConfigs.guildId, guildId));

    cache.set(guildId, result.data);
    this.notifySave(guildId, result.data);
    return { success: true, data: result.data, usedLegacyDiff };
  }

  async reloadGuild(guildId: string): Promise<GuildConfig | null> {
    cache.delete(guildId);
    return this.getGuildConfig(guildId);
  }

  invalidateCache(guildId?: string) {
    if (guildId) {
      cache.delete(guildId);
    } else {
      cache.clear();
    }
  }

  getTemplateYaml(): string {
    clearDefaultConfigCache();
    return loadDefaultConfigRaw();
  }

  async getDownloadYaml(guildId: string): Promise<string> {
    // Prefer the validated/cleaned snapshot so downloads match what the bot actually uses.
    const stored = await this.getGuildConfig(guildId);
    if (stored) {
      return YAML.stringify(stored);
    }
    const db = getDb();
    const row = await db.select().from(guildConfigs).where(eq(guildConfigs.guildId, guildId)).get();
    if (row) {
      return row.configYaml;
    }
    return YAML.stringify(loadDefaultConfig());
  }

  async validateOnly(userYaml: string): Promise<{ success: true } | { success: false; errors: string[] }> {
    const result = validateMergedConfig(userYaml);
    if (!result.success) return result;
    return { success: true };
  }

  mergePreview(userYaml: string): GuildConfig {
    const parsed = YAML.parse(userYaml) as Record<string, unknown>;
    const merged = deepMerge(loadDefaultConfig() as unknown as Record<string, unknown>, parsed ?? {});
    const validated = validateGuildConfig(merged);
    if (!validated.success) {
      throw new Error(validated.errors.join("\n"));
    }
    return validated.data;
  }

  private async loadUserOverrides(guildId: string): Promise<SaveResult | { success: true; data: Record<string, unknown> }> {
    const db = getDb();
    const row = await db.select().from(guildConfigs).where(eq(guildConfigs.guildId, guildId)).get();

    if (row?.userConfigYaml) {
      try {
        return { success: true, data: (parseYamlConfig(row.userConfigYaml) ?? {}) as Record<string, unknown> };
      } catch (e) {
        return { success: false, errors: [`Invalid stored user config: ${e instanceof Error ? e.message : String(e)}`] };
      }
    }

    if (row) {
      try {
        const stored = YAML.parse(row.configYaml) as Record<string, unknown>;
        const oldDefaults = row.defaultsSnapshotYaml
          ? (YAML.parse(row.defaultsSnapshotYaml) as Record<string, unknown>)
          : (loadDefaultConfig() as unknown as Record<string, unknown>);
        return { success: true, data: computeUserOverrides(stored, oldDefaults) };
      } catch (e) {
        return { success: false, errors: [`Failed to compute overrides: ${e instanceof Error ? e.message : String(e)}`] };
      }
    }

    return { success: true, data: {} };
  }

  private async saveUserOverrides(guildId: string, userOverrides: Record<string, unknown>, updatedBy: string): Promise<SaveResult> {
    return this.saveGuildConfig(guildId, YAML.stringify(userOverrides), updatedBy);
  }

  /** Merge top-level keys into the guild's user overrides and save. */
  async patchTopLevelConfig(
    guildId: string,
    patch: Record<string, unknown>,
    updatedBy: string,
  ): Promise<SaveResult> {
    const loaded = await this.loadUserOverrides(guildId);
    if (!loaded.success) return loaded;

    const userOverrides = { ...loaded.data, ...patch };
    return this.saveUserOverrides(guildId, userOverrides, updatedBy);
  }

  async patchPluginConfig(
    guildId: string,
    pluginName: string,
    configPatch: Record<string, unknown | null>,
    updatedBy: string,
  ): Promise<SaveResult> {
    const loaded = await this.loadUserOverrides(guildId);
    if (!loaded.success) return loaded;

    const userOverrides = loaded.data;
    const plugins = { ...((userOverrides.plugins ?? {}) as Record<string, unknown>) };
    const section = { ...((plugins[pluginName] ?? {}) as Record<string, unknown>) };
    const config = { ...((section.config ?? {}) as Record<string, unknown>) };

    for (const [key, value] of Object.entries(configPatch)) {
      if (value === null) {
        delete config[key];
      } else {
        config[key] = value;
      }
    }

    plugins[pluginName] = { ...section, config };
    userOverrides.plugins = plugins;

    return this.saveUserOverrides(guildId, userOverrides, updatedBy);
  }

  async setPluginEnabled(
    guildId: string,
    pluginName: string,
    enabled: boolean,
    updatedBy: string,
  ): Promise<SaveResult> {
    const loaded = await this.loadUserOverrides(guildId);
    if (!loaded.success) return loaded;

    const userOverrides = loaded.data;
    const plugins = { ...((userOverrides.plugins ?? {}) as Record<string, unknown>) };
    const section = { ...((plugins[pluginName] ?? {}) as Record<string, unknown>) };
    plugins[pluginName] = { ...section, enabled };
    userOverrides.plugins = plugins;

    return this.saveUserOverrides(guildId, userOverrides, updatedBy);
  }

  async patchLevels(
    guildId: string,
    levelPatch: Record<string, number | null>,
    updatedBy: string,
  ): Promise<SaveResult> {
    const loaded = await this.loadUserOverrides(guildId);
    if (!loaded.success) return loaded;

    const userOverrides = loaded.data;
    const levels = { ...((userOverrides.levels ?? {}) as Record<string, number>) };

    for (const [id, value] of Object.entries(levelPatch)) {
      if (value === null) {
        delete levels[id];
      } else {
        levels[id] = value;
      }
    }

    userOverrides.levels = levels;
    return this.saveUserOverrides(guildId, userOverrides, updatedBy);
  }

  async setPermissionGrant(
    guildId: string,
    pluginName: string,
    permission: string,
    target: { everyone?: boolean; user?: string; role?: string },
    allowed: boolean,
    updatedBy: string,
  ): Promise<SaveResult> {
    const loaded = await this.loadUserOverrides(guildId);
    if (!loaded.success) return loaded;

    const userOverrides = loaded.data;
    const plugins = { ...((userOverrides.plugins ?? {}) as Record<string, unknown>) };
    const section = { ...((plugins[pluginName] ?? {}) as Record<string, unknown>) };
    const config = { ...((section.config ?? {}) as Record<string, unknown>) };
    let overrides = [...((section.overrides as ConfigOverride[] | undefined) ?? [])];

    if (target.everyone) {
      if (allowed) {
        config[permission] = true;
      } else {
        delete config[permission];
      }
    } else {
      const matchIndex = overrides.findIndex((override) => isPermissionOverrideMatch(override, target));
      if (allowed) {
        if (matchIndex >= 0) {
          overrides[matchIndex] = {
            ...overrides[matchIndex],
            config: { ...overrides[matchIndex].config, [permission]: true },
          };
        } else {
          const next: ConfigOverride = {
            config: { [permission]: true },
          };
          if (target.user) next.user = target.user;
          if (target.role) next.role = target.role;
          overrides.push(next);
        }
      } else if (matchIndex >= 0) {
        const existing = overrides[matchIndex];
        const nextConfig = { ...existing.config };
        delete nextConfig[permission];
        if (Object.keys(nextConfig).length === 0) {
          overrides = overrides.filter((_, index) => index !== matchIndex);
        } else {
          overrides[matchIndex] = { ...existing, config: nextConfig };
        }
      }
    }

    const nextSection: Record<string, unknown> = { ...section, config };
    if (overrides.length > 0) {
      nextSection.overrides = overrides;
    } else {
      delete nextSection.overrides;
    }

    plugins[pluginName] = nextSection;
    userOverrides.plugins = plugins;
    return this.saveUserOverrides(guildId, userOverrides, updatedBy);
  }
}

export const configManager = new ConfigManager();
