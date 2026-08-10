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

export type WebAutomodPayload = {
  enabled: boolean;
  config: AutomodConfig;
  catalog: ReturnType<typeof getAutomodCatalog>;
};

function withFullRules(config: AutomodConfig): AutomodConfig {
  return {
    ...config,
    rules: { ...defaultAutomodRules(), ...config.rules },
  };
}

export async function getWebAutomodState(guildId: string): Promise<WebAutomodPayload> {
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

  return {
    enabled: guildConfig.plugins.automod?.enabled === true,
    config: withFullRules(config),
    catalog: getAutomodCatalog(),
  };
}

export async function saveWebAutomod(
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

  return getWebAutomodState(guildId);
}

export async function applyWebAutomodPreset(
  guildId: string,
  userId: string,
  preset: AutomodPresetName,
  options: { enablePlugin?: boolean; preview?: boolean } = {},
): Promise<WebAutomodPayload> {
  const current = await getWebAutomodState(guildId);
  const next = applyPresetToConfig(current.config, preset);
  if (options.preview) {
    return {
      enabled: options.enablePlugin === false ? current.enabled : true,
      config: withFullRules(next),
      catalog: current.catalog,
    };
  }
  return saveWebAutomod(guildId, userId, {
    enabled: options.enablePlugin === false ? current.enabled : true,
    config: next,
  });
}

export async function testWebAutomod(guildId: string, sample: string): Promise<{ lines: string[] }> {
  const state = await getWebAutomodState(guildId);
  return { lines: await testAutomodRules(sample, state.config) };
}
