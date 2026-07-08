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



const cache = new Map<string, GuildConfig>();



export class ConfigManager {

  async getGuildConfig(guildId: string): Promise<GuildConfig | null> {

    if (cache.has(guildId)) {

      return cache.get(guildId)!;

    }



    const db = getDb();

    const row = await db.select().from(guildConfigs).where(eq(guildConfigs.guildId, guildId)).get();

    if (!row) {

      return null;

    }



    const parsed = YAML.parse(row.configYaml) as GuildConfig;

    const validated = validateGuildConfig(parsed);

    if (!validated.success) {

      return null;

    }



    cache.set(guildId, validated.data);

    return validated.data;

  }



  async getEffectiveConfig(guildId: string): Promise<GuildConfig> {

    const stored = await this.getGuildConfig(guildId);

    if (stored) return stored;

    return loadDefaultConfig();

  }



  hasGuildConfig(guildId: string): boolean {

    return cache.has(guildId);

  }



  async saveGuildConfig(guildId: string, userYaml: string, updatedBy: string): Promise<{ success: true; data: GuildConfig } | { success: false; errors: string[] }> {

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



  async patchPluginConfig(

    guildId: string,

    pluginName: string,

    configPatch: Record<string, unknown | null>,

    updatedBy: string,

  ): Promise<{ success: true; data: GuildConfig } | { success: false; errors: string[] }> {

    const db = getDb();

    const row = await db.select().from(guildConfigs).where(eq(guildConfigs.guildId, guildId)).get();



    let userOverrides: Record<string, unknown>;

    if (row?.userConfigYaml) {

      try {

        userOverrides = (parseYamlConfig(row.userConfigYaml) ?? {}) as Record<string, unknown>;

      } catch (e) {

        return { success: false, errors: [`Invalid stored user config: ${e instanceof Error ? e.message : String(e)}`] };

      }

    } else if (row) {

      try {

        const stored = YAML.parse(row.configYaml) as Record<string, unknown>;

        const oldDefaults = row.defaultsSnapshotYaml

          ? (YAML.parse(row.defaultsSnapshotYaml) as Record<string, unknown>)

          : (loadDefaultConfig() as unknown as Record<string, unknown>);

        userOverrides = computeUserOverrides(stored, oldDefaults);

      } catch (e) {

        return { success: false, errors: [`Failed to compute overrides: ${e instanceof Error ? e.message : String(e)}`] };

      }

    } else {

      userOverrides = {};

    }



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



    return this.saveGuildConfig(guildId, YAML.stringify(userOverrides), updatedBy);

  }

}



export const configManager = new ConfigManager();

