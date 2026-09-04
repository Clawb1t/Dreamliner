import { eq } from "drizzle-orm";
import YAML from "yaml";

import { getDb } from "../db/client.js";
import { guildConfigs } from "../db/schema.js";
import { loadDefaultConfig, loadDefaultConfigRaw } from "./default.js";
import {
  computeUserOverrides,
  deepMerge,
  parseYamlConfig,
  validateGuildConfig,
  validateMergedConfig,
} from "./validator.js";
import type { GuildConfig } from "./schemas/guild.js";
import { migrateLegacyEmojisInGuildConfig, migrateLegacyEmojisInObject } from "./emojiMigration.js";

const cache = new Map<string, GuildConfig>();

type SaveResult = { success: true; data: GuildConfig } | { success: false; errors: string[] };

type ConfigSaveListener = (guildId: string, config: GuildConfig) => void;

export class ConfigManager {
  private saveListeners = new Set<ConfigSaveListener>();
  // Guilds with no row in guild_configs at all — a normal, expected state (never
  // ran /config upload), not an error. Tracked so getEffectiveConfig can tell
  // that apart from a stored config that actually failed to validate.
  private guildsWithoutStoredConfig = new Set<string>();

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
      this.guildsWithoutStoredConfig.add(guildId);
      return null;
    }
    this.guildsWithoutStoredConfig.delete(guildId);

    let parsed: unknown;
    try {
      parsed = YAML.parse(row.configYaml);
    } catch (error) {
      console.error(
        `[dreamliner] Guild config YAML for ${guildId} would not parse, repairing from what's on file:`,
        error instanceof Error ? error.message : error,
      );
      parsed = undefined;
    }

    // repairGuildConfig always converges to *something* valid — it fills missing
    // structure from defaults, strips obsolete/invalid fragments, and as a last
    // resort resets just the broken section(s). Worst case it falls all the way
    // back to clean defaults, but it never just gives up. See validator.ts.
    let validated = validateGuildConfig(parsed ?? {}, { repair: true });
    let repairs = validated.success ? validated.repairs ?? validated.strippedKeys ?? [] : [];
    const neededFullReset = !validated.success || repairs.some((r) => r.startsWith("(full reset"));

    // A full reset throws away every customization. If the guild's own override
    // diff is still on file, rebuilding straight from that almost always keeps
    // far more of their setup than falling all the way back to bare defaults.
    if (neededFullReset && row.userConfigYaml) {
      try {
        const userOverrides = (parseYamlConfig(row.userConfigYaml) ?? {}) as Record<string, unknown>;
        const merged = deepMerge(loadDefaultConfig() as unknown as Record<string, unknown>, userOverrides);
        const rebuilt = validateGuildConfig(merged, { repair: true });
        if (rebuilt.success) {
          const rebuiltRepairs = rebuilt.repairs ?? rebuilt.strippedKeys ?? [];
          if (!rebuiltRepairs.some((r) => r.startsWith("(full reset"))) {
            validated = rebuilt;
            repairs = [
              ...rebuiltRepairs,
              "(rebuilt from stored overrides — the saved snapshot needed a full reset)",
            ];
          }
        }
      } catch (error) {
        console.error(
          `[dreamliner] Failed to rebuild guild config for ${guildId} from stored overrides:`,
          error,
        );
      }
    }

    if (!validated.success) {
      // Should be unreachable: repairGuildConfig only fails to converge when the
      // shipped defaults themselves don't validate, which is a bug to fix in
      // code/schema, not something a per-guild config repair can resolve.
      console.error(
        `[dreamliner] Guild config for ${guildId} could not be repaired even from defaults (this points to a bug in the schema/defaults):`,
        validated.errors,
      );
      return null;
    }

    if (repairs.length) {
      console.warn(
        `[dreamliner] Repaired guild config for ${guildId} (kept valid settings): ${repairs.join(", ")}`,
      );
    }

    const migratedEmojis = migrateLegacyEmojisInGuildConfig(validated.data);
    const data: GuildConfig = migratedEmojis.data;

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
    // Only warn when a stored config actually exists but failed to validate
    // (getGuildConfig already logged the specifics above) — a guild that has
    // simply never saved a config is expected to fall back to defaults.
    if (!this.guildsWithoutStoredConfig.has(guildId)) {
      console.warn(
        `[dreamliner] No valid stored config for guild ${guildId}; using default.server.yaml (custom settings are not applied until config loads successfully).`,
      );
    }
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
    this.guildsWithoutStoredConfig.delete(guildId);
    this.notifySave(guildId, result.data);
    return { success: true, data: result.data };
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

}

export const configManager = new ConfigManager();
