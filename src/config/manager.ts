import { eq } from "drizzle-orm";
import YAML from "yaml";

import { getDb } from "../db/client.js";
import { guildConfigs } from "../db/schema.js";
import { loadDefaultConfig } from "./default.js";
import {
  computeUserOverrides,
  deepMerge,
  parseYamlConfig,
  validateGuildConfig,
  validateMergedConfig,
} from "./validator.js";
import type { GuildConfig } from "./schemas/guild.js";
import { migrateLegacyEmojisInGuildConfig, migrateLegacyEmojisInObject } from "./emojiMigration.js";
import { getLogger } from "../core/logger.js";
import { actorFromUpdatedBy, addedGrantableRoleIds } from "./grantableRoleFields.js";
import { addedManagedChannelIds } from "./managedChannelFields.js";
const log = getLogger("config");

const cache = new Map<string, GuildConfig>();

type SaveResult = { success: true; data: GuildConfig } | { success: false; errors: string[]; code?: string };

/**
 * Checks that `actorId` could do themselves what newly added settings make the bot do: hand out
 * these roles (grantableRoleFields.ts) and create in or rename these channels
 * (managedChannelFields.ts). Returns the problems, empty when allowed. Installed at boot by the bot
 * (it needs the live guild); without one (tests, scripts) saves aren't checked.
 */
export type RoleGrantGuard = (guildId: string, actorId: string, added: { roleIds: string[]; channelIds: string[] }) => Promise<string[]>;

/** Error code on a SaveResult refused because the saver couldn't do what the new settings make the bot do. */
export const ROLE_GRANT_REFUSED = "actor_permissions";

/** `previous` is the guild's config from just before this save (null when it had none), so a
 *  listener can react to what was removed, e.g. clean up Discord posts for deleted entries. */
type ConfigSaveListener = (guildId: string, config: GuildConfig, previous: GuildConfig | null) => void;

/**
 * Ids only the bot itself writes: the Scam Protect honeypot channel it creates, and its warning
 * message. The bot renames, moves and deletes that channel and softbans anyone who posts in it, so
 * a dashboard save pointing it at an existing channel would turn the bot on that channel. Saves
 * made for a person (actorFromUpdatedBy) always keep the bot's current values.
 */
const BOT_OWNED_FIELDS: ReadonlyArray<readonly [plugin: string, key: string]> = [
  ["scam_protect", "channel_id"],
  ["scam_protect", "warning_message_id"],
];

function pluginConfigOf(root: Record<string, unknown>, plugin: string, create: boolean): Record<string, unknown> | null {
  const plugins = root.plugins as Record<string, unknown> | undefined;
  if (!plugins || typeof plugins !== "object") {
    if (!create) return null;
    root.plugins = {};
    return pluginConfigOf(root, plugin, create);
  }
  let section = plugins[plugin] as Record<string, unknown> | undefined;
  if (!section || typeof section !== "object") {
    if (!create) return null;
    section = plugins[plugin] = {};
  }
  let config = section.config as Record<string, unknown> | undefined;
  if (!config || typeof config !== "object") {
    if (!create) return null;
    config = section.config = {};
  }
  return config;
}

function keepBotOwnedFields(previous: GuildConfig | null, merged: GuildConfig, user: Record<string, unknown>): void {
  for (const [plugin, key] of BOT_OWNED_FIELDS) {
    const before = previous ? pluginConfigOf(previous as unknown as Record<string, unknown>, plugin, false)?.[key] : undefined;
    const mergedConfig = pluginConfigOf(merged as unknown as Record<string, unknown>, plugin, false);
    if (before === undefined || before === null || before === "") {
      if (mergedConfig && key in mergedConfig) delete mergedConfig[key];
      const userConfig = pluginConfigOf(user, plugin, false);
      if (userConfig) delete userConfig[key];
      continue;
    }
    if (mergedConfig) mergedConfig[key] = before;
    pluginConfigOf(user, plugin, true)![key] = before;
  }
}

export class ConfigManager {
  private saveListeners = new Set<ConfigSaveListener>();
  private roleGrantGuard: RoleGrantGuard | null = null;
  // Guilds with no row in guild_configs at all — a normal, expected state (never
  // ran /config upload), not an error. Tracked so getEffectiveConfig can tell
  // that apart from a stored config that actually failed to validate.
  private guildsWithoutStoredConfig = new Set<string>();

  // Serializes the read-modify-write patch methods below (loadUserOverrides -> mutate ->
  // saveUserOverrides) per guild, so two concurrent patches for the same guild (e.g. the
  // dashboard firing off two plugin saves back to back) queue up instead of racing and one
  // silently clobbering the other's change.
  private writeQueues = new Map<string, Promise<unknown>>();

  private runSerialized<T>(guildId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(guildId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => {});
    this.writeQueues.set(guildId, settled);
    void settled.finally(() => {
      if (this.writeQueues.get(guildId) === settled) this.writeQueues.delete(guildId);
    });
    return next;
  }

  /** Installs (or, with null, removes) the check every save runs on newly added grantable roles. */
  setRoleGrantGuard(guard: RoleGrantGuard | null): void {
    this.roleGrantGuard = guard;
  }

  onSave(listener: ConfigSaveListener): () => void {
    this.saveListeners.add(listener);
    return () => {
      this.saveListeners.delete(listener);
    };
  }

  private notifySave(guildId: string, config: GuildConfig, previous: GuildConfig | null): void {
    for (const listener of this.saveListeners) {
      try {
        listener(guildId, config, previous);
      } catch (error) {
        log.error("[dreamliner] Config save listener failed:", error);
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
      parsed = JSON.parse(row.configJson);
    } catch (error) {
      log.error(
        `[dreamliner] Guild config JSON for ${guildId} would not parse, repairing from what's on file:`,
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
    if (neededFullReset && row.userConfigJson) {
      try {
        const userOverrides = (JSON.parse(row.userConfigJson) ?? {}) as Record<string, unknown>;
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
        log.error(
          `[dreamliner] Failed to rebuild guild config for ${guildId} from stored overrides:`,
          error,
        );
      }
    }

    if (!validated.success) {
      // Should be unreachable: repairGuildConfig only fails to converge when the
      // shipped defaults themselves don't validate, which is a bug to fix in
      // code/schema, not something a per-guild config repair can resolve.
      log.error(
        `[dreamliner] Guild config for ${guildId} could not be repaired even from defaults (this points to a bug in the schema/defaults):`,
        validated.errors,
      );
      return null;
    }

    if (repairs.length) {
      log.warn(
        `[dreamliner] Repaired guild config for ${guildId} (kept valid settings): ${repairs.join(", ")}`,
      );
    }

    const migratedEmojis = migrateLegacyEmojisInGuildConfig(validated.data);
    const data: GuildConfig = migratedEmojis.data;

    cache.set(guildId, data);

    const shouldPersistCleanup = repairs.length > 0 || migratedEmojis.changed;
    if (shouldPersistCleanup) {
      void this.persistConfigCleanup(guildId, data, row.userConfigJson, {
        emojiMigration: migratedEmojis.changed,
        strippedKeys: repairs,
      }).catch((error) => {
        log.error(`[dreamliner] Failed to persist config cleanup for ${guildId}:`, error);
      });
    }

    return data;
  }

  private async persistConfigCleanup(
    guildId: string,
    config: GuildConfig,
    userConfigJson: string | null | undefined,
    reason: { emojiMigration: boolean; strippedKeys: string[] },
  ): Promise<void> {
    let nextUserConfigJson = userConfigJson ?? null;
    if (userConfigJson) {
      try {
        const parsed = (JSON.parse(userConfigJson) ?? {}) as Record<string, unknown>;
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
        nextUserConfigJson = JSON.stringify(migrated.value);
      } catch (error) {
        // Keep original user config if it cannot be parsed.
        log.warn(`[dreamliner] Could not clean up stored user config for guild ${guildId}:`, error);
      }
    }

    const updatedBy = reason.emojiMigration
      ? "system:emoji-migration"
      : "system:config-cleanup";

    const db = getDb();
    await db
      .update(guildConfigs)
      .set({
        configJson: JSON.stringify(config),
        userConfigJson: nextUserConfigJson,
        updatedAt: new Date(),
        updatedBy,
      })
      .where(eq(guildConfigs.guildId, guildId));

    if (reason.emojiMigration) {
      log.info(`[dreamliner] Migrated legacy response emojis for guild ${guildId}`);
    }
    if (reason.strippedKeys.length > 0) {
      log.info(`[dreamliner] Persisted repaired guild config for ${guildId}`);
    }
  }

  async getEffectiveConfig(guildId: string): Promise<GuildConfig> {
    const stored = await this.getGuildConfig(guildId);
    if (stored) return stored;
    // Only warn when a stored config actually exists but failed to validate
    // (getGuildConfig already logged the specifics above) — a guild that has
    // simply never saved a config is expected to fall back to defaults.
    if (!this.guildsWithoutStoredConfig.has(guildId)) {
      log.warn(
        `[dreamliner] No valid stored config for guild ${guildId}; using the built-in defaults (custom settings are not applied until config loads successfully).`,
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

    const previous = await this.getGuildConfig(guildId).catch(() => null);

    // Roles the bot will give or take: whoever adds one must be able to give it themselves.
    // Only newly added ids are checked, so roles already saved by someone else keep working.
    const actorId = actorFromUpdatedBy(updatedBy);
    if (actorId && this.roleGrantGuard) {
      const before = previous ?? loadDefaultConfig();
      const added = { roleIds: addedGrantableRoleIds(before, result.data), channelIds: addedManagedChannelIds(before, result.data) };
      if (added.roleIds.length || added.channelIds.length) {
        const problems = await this.roleGrantGuard(guildId, actorId, added);
        if (problems.length) return { success: false, errors: problems, code: ROLE_GRANT_REFUSED };
      }
    }

    const defaultsSnapshotJson = JSON.stringify(loadDefaultConfig());
    let parsedUser: Record<string, unknown>;
    try {
      parsedUser = (parseYamlConfig(userYaml) ?? {}) as Record<string, unknown>;
    } catch {
      // Shouldn't happen — validateMergedConfig above already parsed this same YAML successfully.
      parsedUser = {};
    }
    // Saves made for a person can't move ids only the bot writes (see BOT_OWNED_FIELDS).
    if (actorId) keepBotOwnedFields(previous, result.data, parsedUser);
    const userConfigJson = JSON.stringify(parsedUser);
    const configJson = JSON.stringify(result.data);

    const db = getDb();
    await db
      .insert(guildConfigs)
      .values({
        guildId,
        configJson,
        userConfigJson,
        defaultsSnapshotJson,
        updatedAt: new Date(),
        updatedBy,
      })
      .onConflictDoUpdate({
        target: guildConfigs.guildId,
        set: {
          configJson,
          userConfigJson,
          defaultsSnapshotJson,
          updatedAt: new Date(),
          updatedBy,
        },
      });

    cache.set(guildId, result.data);
    this.guildsWithoutStoredConfig.delete(guildId);
    this.notifySave(guildId, result.data, previous);
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
      try {
        return YAML.stringify(JSON.parse(row.configJson));
      } catch {
        // Fall through to defaults below if the stored row is somehow unparseable.
      }
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

    if (row?.userConfigJson) {
      try {
        return { success: true, data: (JSON.parse(row.userConfigJson) ?? {}) as Record<string, unknown> };
      } catch (e) {
        return { success: false, errors: [`Invalid stored user config: ${e instanceof Error ? e.message : String(e)}`] };
      }
    }

    if (row) {
      try {
        const stored = JSON.parse(row.configJson) as Record<string, unknown>;
        const oldDefaults = row.defaultsSnapshotJson
          ? (JSON.parse(row.defaultsSnapshotJson) as Record<string, unknown>)
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
    return this.runSerialized(guildId, async () => {
      const loaded = await this.loadUserOverrides(guildId);
      if (!loaded.success) return loaded;

      const userOverrides = { ...loaded.data, ...patch };
      return this.saveUserOverrides(guildId, userOverrides, updatedBy);
    });
  }

  async patchPluginConfig(
    guildId: string,
    pluginName: string,
    configPatch: Record<string, unknown | null>,
    updatedBy: string,
  ): Promise<SaveResult> {
    return this.runSerialized(guildId, async () => {
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
    });
  }

  async setPluginEnabled(
    guildId: string,
    pluginName: string,
    enabled: boolean,
    updatedBy: string,
  ): Promise<SaveResult> {
    return this.runSerialized(guildId, async () => {
      const loaded = await this.loadUserOverrides(guildId);
      if (!loaded.success) return loaded;

      const userOverrides = loaded.data;
      const plugins = { ...((userOverrides.plugins ?? {}) as Record<string, unknown>) };
      const section = { ...((plugins[pluginName] ?? {}) as Record<string, unknown>) };
      plugins[pluginName] = { ...section, enabled };
      userOverrides.plugins = plugins;

      return this.saveUserOverrides(guildId, userOverrides, updatedBy);
    });
  }

}

export const configManager = new ConfigManager();
