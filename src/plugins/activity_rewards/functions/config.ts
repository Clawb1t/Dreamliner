import {
  zActivityRewardsConfig,
  type ActivityMetric,
  type ActivityMilestone,
  type ActivityRewardsConfig,
} from "../../../config/schemas/activityRewards.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { configManager } from "../../../config/manager.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";

export const PLUGIN = "activity_rewards";

export type ActivityProgress = {
  messages: number;
  voiceSeconds: number;
};

// configManager hands back the same GuildConfig object until the guild's config is saved again,
// so parsed plugin configs are memoized per object, since every counted message reads this.
const parsedByGuildConfig = new WeakMap<GuildConfig, ActivityRewardsConfig>();

export function loadActivityRewardsConfig(guildConfig: GuildConfig): ActivityRewardsConfig {
  let parsed = parsedByGuildConfig.get(guildConfig);
  if (!parsed) {
    parsed = parsePluginConfig(zActivityRewardsConfig, getPluginSettings(guildConfig, PLUGIN));
    parsedByGuildConfig.set(guildConfig, parsed);
  }
  return parsed;
}

/** The guild's config when the plugin is on and has at least one live milestone, else null. */
export async function loadActiveActivityRewards(guildId: string): Promise<ActivityRewardsConfig | null> {
  const guildConfig = await configManager.getEffectiveConfig(guildId).catch(() => null);
  if (!guildConfig || !pluginEnabled(guildConfig, PLUGIN)) return null;
  const config = loadActivityRewardsConfig(guildConfig);
  return activeMilestones(config).length > 0 ? config : null;
}

/** Enabled milestones, sorted by track then ascending threshold. */
export function activeMilestones(config: ActivityRewardsConfig, metric?: ActivityMetric): ActivityMilestone[] {
  return config.milestones
    .filter((m) => m.enabled !== false && (!metric || m.metric === metric))
    .sort((a, b) => (a.metric === b.metric ? a.threshold - b.threshold : a.metric === "messages" ? -1 : 1));
}

/** A member's value on a milestone's track, in the milestone's own unit (messages or minutes). */
export function metricValue(progress: ActivityProgress, metric: ActivityMetric): number {
  return metric === "messages" ? progress.messages : Math.floor(progress.voiceSeconds / 60);
}

export function hasReached(progress: ActivityProgress, milestone: ActivityMilestone): boolean {
  return metricValue(progress, milestone.metric) >= milestone.threshold;
}

export function formatCount(n: number): string {
  return Math.max(0, Math.floor(n)).toLocaleString("en-US");
}

/** "90 minutes" / "2 hours" / "2h 30m": a threshold in minutes, readable. */
export function formatVoiceMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return `${formatCount(hours)} hour${hours === 1 ? "" : "s"}`;
  return `${formatCount(hours)}h ${rest}m`;
}

/** Tracked voice time, e.g. "12h 30m" or "45m". */
export function formatVoiceSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${formatCount(hours)}h ${minutes % 60}m` : `${minutes}m`;
}

export function requirementLabel(milestone: Pick<ActivityMilestone, "metric" | "threshold">): string {
  return milestone.metric === "messages"
    ? `${formatCount(milestone.threshold)} message${milestone.threshold === 1 ? "" : "s"}`
    : `${formatVoiceMinutes(milestone.threshold)} in voice`;
}

export function milestoneLabel(milestone: ActivityMilestone): string {
  return milestone.name.trim() || requirementLabel(milestone);
}

/** Every role ID the plugin manages (granted by any live milestone). */
export function managedRoleIds(config: ActivityRewardsConfig): Set<string> {
  return new Set(activeMilestones(config).flatMap((m) => m.roles));
}

export function isIgnoredChannel(config: ActivityRewardsConfig, ...ids: Array<string | null | undefined>): boolean {
  if (config.ignored_channels.length === 0) return false;
  return ids.some((id) => Boolean(id) && config.ignored_channels.includes(id!));
}

export function hasIgnoredRole(config: ActivityRewardsConfig, roleIds: Iterable<string>): boolean {
  if (config.ignored_roles.length === 0) return false;
  for (const id of roleIds) if (config.ignored_roles.includes(id)) return true;
  return false;
}
