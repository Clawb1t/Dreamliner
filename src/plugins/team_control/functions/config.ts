import { zTeamControlConfig, type TeamControlConfig } from "../../../config/schemas/teamControl.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { configManager } from "../../../config/manager.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";

export const PLUGIN = "team_control";

/** Button and modal customId prefix, routed in bot.ts. */
export const TEAM_PREFIX = "team:";

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

/** Text limits shared by commands, modals and the bridge. */
export const MAX_REASON = 500;
export const MAX_NOTE = 1000;
export const MAX_COMMENT = 500;

/** How long a "Yes, terminate" style confirmation button stays valid. */
export const CONFIRM_TTL_MS = 5 * MINUTE_MS;

export type TeamStatus = "on_duty" | "on_break" | "off_duty" | "loa" | "ra" | "suspended";
export type TeamActionType = "promotion" | "demotion" | "warning" | "strike" | "suspension" | "termination";
export const TEAM_ACTION_TYPES: TeamActionType[] = ["promotion", "demotion", "warning", "strike", "suspension", "termination"];
export type LeaveKind = "loa" | "ra";
export type LeaveStatus = "pending" | "approved" | "denied" | "active" | "ended" | "cancelled";
export type ShiftStatus = "active" | "ended" | "voided";
export type MemberStatus = "active" | "suspended" | "terminated";

// configManager hands back the same GuildConfig object until the guild's config is saved again,
// so parsed plugin configs are memoized per object (every staff message reads this).
const parsedByGuildConfig = new WeakMap<GuildConfig, TeamControlConfig>();

export function loadTeamControlConfig(guildConfig: GuildConfig): TeamControlConfig {
  let parsed = parsedByGuildConfig.get(guildConfig);
  if (!parsed) {
    parsed = parsePluginConfig(zTeamControlConfig, getPluginSettings(guildConfig, PLUGIN));
    parsedByGuildConfig.set(guildConfig, parsed);
  }
  return parsed;
}

export function isTeamControlEnabled(guildConfig: GuildConfig): boolean {
  return pluginEnabled(guildConfig, PLUGIN);
}

/** The guild's config and plugin config when the plugin is on, else null. */
export async function loadActiveTeamControl(guildId: string): Promise<{ guildConfig: GuildConfig; config: TeamControlConfig } | null> {
  const guildConfig = await configManager.getEffectiveConfig(guildId).catch(() => null);
  if (!guildConfig || !isTeamControlEnabled(guildConfig)) return null;
  return { guildConfig, config: loadTeamControlConfig(guildConfig) };
}

/** A configured channel, falling back to the plugin's default log channel. */
export function channelOr(config: TeamControlConfig, channelId: string | null): string | null {
  return channelId ?? config.log_channel_id;
}

/** "3h 25m" / "45m" / "0m". */
export function formatMinutes(totalMinutes: number): string {
  const minutes = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function unix(date: Date | number): number {
  return Math.floor((typeof date === "number" ? date : date.getTime()) / 1000);
}

export const ACTION_LABELS: Record<TeamActionType, string> = {
  promotion: "Promotion",
  demotion: "Demotion",
  warning: "Warning",
  strike: "Strike",
  suspension: "Suspension",
  termination: "Termination",
};

export const LEAVE_LABELS: Record<LeaveKind, string> = { loa: "Leave of absence", ra: "Reduced activity" };

export const STATUS_DOTS: Record<TeamStatus, string> = {
  on_duty: "🟢",
  on_break: "🟡",
  off_duty: "⚫",
  loa: "🌙",
  ra: "🔸",
  suspended: "⏸️",
};
