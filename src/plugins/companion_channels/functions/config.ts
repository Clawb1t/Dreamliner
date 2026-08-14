import {
  zCompanionChannelsConfig,
  type CompanionChannelsConfig,
  type CompanionFeatureKey,
  type CompanionSetup,
} from "../../../config/schemas/companion.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { resolvePluginConfig } from "../../../core/permissions.js";

export function loadCompanionConfig(guildConfig: GuildConfig): CompanionChannelsConfig {
  // Overrides are untyped records, so leftover hub-command keys (can_create / can_delete)
  // can still be merged in. Strip unknowns instead of failing the whole plugin.
  return zCompanionChannelsConfig.strip().parse(resolvePluginConfig(guildConfig, "companion_channels"));
}

export function enabledSetups(config: CompanionChannelsConfig): CompanionSetup[] {
  const seen = new Set<string>();
  const out: CompanionSetup[] = [];
  for (const setup of config.setups) {
    const hubId = setup.hub_channel_id.trim();
    if (!setup.enabled || !hubId || seen.has(hubId)) continue;
    seen.add(hubId);
    out.push({ ...setup, hub_channel_id: hubId });
  }
  return out;
}

export function setupByHub(config: CompanionChannelsConfig, hubChannelId: string): CompanionSetup | undefined {
  return enabledSetups(config).find((setup) => setup.hub_channel_id === hubChannelId);
}

export function featureEnabled(config: CompanionChannelsConfig, key: CompanionFeatureKey): boolean {
  return Boolean(config.features[key]);
}
