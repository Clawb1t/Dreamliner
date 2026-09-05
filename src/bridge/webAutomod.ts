import type { Client } from "discord.js";
import {
  zAutomodConfig,
  type AutomodConfig,
  type AutomodPresetName,
} from "../config/schemas/automod.js";
import { configManager } from "../config/manager.js";
import { getAutomodCatalog } from "../plugins/automod/catalog.js";
import { testAutomodRules } from "../plugins/automod/functions/handlers.js";
import {
  mergeCensorDbRulesIntoConfig,
  parseAutomodConfig,
} from "../plugins/automod/functions/migrate.js";
import { applyPresetToConfig, defaultAutomodRules } from "../plugins/automod/functions/presets.js";
import {
  getNativeAutomodStatus,
  syncNativeAutomodRules,
  type NativeSyncResult,
} from "../plugins/automod/functions/nativeSync.js";

export type WebAutomodPayload = {
  enabled: boolean;
  config: AutomodConfig;
  catalog: ReturnType<typeof getAutomodCatalog>;
  native?: Omit<NativeSyncResult, "ok"> & { ok: boolean };
};

function withFullRules(config: AutomodConfig): AutomodConfig {
  return {
    ...config,
    rules: { ...defaultAutomodRules(), ...config.rules },
  };
}

export async function getWebAutomodState(client: Client, guildId: string): Promise<WebAutomodPayload> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  let config = parseAutomodConfig(guildConfig.plugins.automod?.config ?? {});
  const before = JSON.stringify(config.migrations);
  config = await mergeCensorDbRulesIntoConfig(guildId, config);

  if (JSON.stringify(config.migrations) !== before) {
    await configManager
      .patchPluginConfig(
        guildId,
        "automod",
        {
          rules: config.rules,
          migrations: config.migrations,
          ignored_channels: config.ignored_channels,
        },
        "system:automod-censor-migrate",
      )
      .catch(() => null);
  }

  const native = await getNativeAutomodStatus(client, guildId).catch(
    (error): Awaited<ReturnType<typeof getNativeAutomodStatus>> => ({
      ok: false,
      supported: false,
      enabled: config.native.enabled,
      error: error instanceof Error ? error.message : "Failed to read native AutoMod status.",
      rules: [],
      syncedAt: new Date().toISOString(),
    }),
  );

  return {
    enabled: guildConfig.plugins.automod?.enabled === true,
    config: withFullRules(config),
    catalog: getAutomodCatalog(),
    native,
  };
}

export async function saveWebAutomod(
  client: Client,
  guildId: string,
  userId: string,
  input: { enabled?: boolean; config?: unknown },
): Promise<WebAutomodPayload> {
  if (input.config !== undefined) {
    const parsed = parseAutomodConfig(zAutomodConfig.parse(input.config));
    const result = await configManager.patchPluginConfig(guildId, "automod", parsed, userId);
    if (!result.success) {
      throw new Error(result.errors.join("\n"));
    }
  }

  if (typeof input.enabled === "boolean") {
    const result = await configManager.setPluginEnabled(guildId, "automod", input.enabled, userId);
    if (!result.success) {
      throw new Error(result.errors.join("\n"));
    }
  }

  // Best-effort: reflect the just-saved config into native Discord AutoMod immediately,
  // rather than waiting for the next boot resync. Failures surface via the `native` field
  // in the returned state, not as a save error — the Dreamliner-side config always saves.
  await syncNativeAutomodRules(client, guildId).catch(() => null);

  return getWebAutomodState(client, guildId);
}

export async function applyWebAutomodPreset(
  client: Client,
  guildId: string,
  userId: string,
  preset: AutomodPresetName,
  options: { enablePlugin?: boolean; preview?: boolean } = {},
): Promise<WebAutomodPayload> {
  const current = await getWebAutomodState(client, guildId);
  const next = applyPresetToConfig(current.config, preset);
  if (options.preview) {
    return {
      enabled: options.enablePlugin === false ? current.enabled : true,
      config: withFullRules(next),
      catalog: current.catalog,
    };
  }
  return saveWebAutomod(client, guildId, userId, {
    enabled: options.enablePlugin === false ? current.enabled : true,
    config: next,
  });
}

export async function testWebAutomod(client: Client, guildId: string, sample: string): Promise<{ lines: string[] }> {
  const state = await getWebAutomodState(client, guildId);
  return { lines: await testAutomodRules(sample, state.config) };
}

export async function syncWebAutomodNative(client: Client, guildId: string): Promise<WebAutomodPayload> {
  await syncNativeAutomodRules(client, guildId);
  return getWebAutomodState(client, guildId);
}
