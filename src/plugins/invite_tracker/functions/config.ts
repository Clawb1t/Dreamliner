import { zInviteTrackerConfig, type InviteTrackerConfig } from "../../../config/schemas/inviteTracker.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { configManager } from "../../../config/manager.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { parsePluginConfig } from "../../../core/pluginSchemas.js";

export const PLUGIN = "invite_tracker";

/** Tracked links per server (each one is a real Discord invite). */
export const MAX_TRACKED_LINKS = 50;
/** Roles a tracked link can give. */
export const MAX_LINK_ROLES = 5;
export const TRACKED_LINK_REASON = "Dreamliner tracked link";

/** Button customId prefix, routed in bot.ts. `invtr:reset_all:<invoker id>` confirms /invites reset all. */
export const INVITE_TRACKER_PREFIX = "invtr:";
export const RESET_ALL_BUTTON = `${INVITE_TRACKER_PREFIX}reset_all`;

export type JoinSource = "invite" | "vanity" | "oauth" | "tracked" | "unknown";
export type JoinStatus = "pending" | "valid" | "fake";
export type FakeReason = "self" | "blacklist" | "bot" | "account_age" | "rejoin" | "quick_leave" | "unverified";

export const JOIN_SOURCES: JoinSource[] = ["invite", "tracked", "vanity", "oauth", "unknown"];

export type InviteCounts = { regular: number; left: number; fake: number; bonus: number; total: number };

export const EMPTY_COUNTS: InviteCounts = { regular: 0, left: 0, fake: 0, bonus: 0, total: 0 };

// configManager hands back the same GuildConfig object until the guild's config is saved again,
// so parsed plugin configs are memoized per object, since every join reads this.
const parsedByGuildConfig = new WeakMap<GuildConfig, InviteTrackerConfig>();

export function loadInviteTrackerConfig(guildConfig: GuildConfig): InviteTrackerConfig {
  let parsed = parsedByGuildConfig.get(guildConfig);
  if (!parsed) {
    parsed = parsePluginConfig(zInviteTrackerConfig, getPluginSettings(guildConfig, PLUGIN));
    parsedByGuildConfig.set(guildConfig, parsed);
  }
  return parsed;
}

export function isInviteTrackerEnabled(guildConfig: GuildConfig): boolean {
  return pluginEnabled(guildConfig, PLUGIN);
}

/** The guild's config when the plugin is on, else null. */
export async function loadActiveInviteTrackerConfig(guildId: string): Promise<InviteTrackerConfig | null> {
  const guildConfig = await configManager.getEffectiveConfig(guildId).catch(() => null);
  if (!guildConfig || !isInviteTrackerEnabled(guildConfig)) return null;
  return loadInviteTrackerConfig(guildConfig);
}

export function formatCount(n: number): string {
  return Math.trunc(n).toLocaleString("en-US");
}

/** "3 days" / "5 hours" / "2 years": how old an account is, for {account_age}. */
export function formatAccountAge(createdAt: Date | number, now = Date.now()): string {
  const ms = Math.max(0, now - (typeof createdAt === "number" ? createdAt : createdAt.getTime()));
  const units: Array<[string, number]> = [
    ["year", 365 * 86_400_000],
    ["month", 30 * 86_400_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, size] of units) {
    const n = Math.floor(ms / size);
    if (n >= 1) return `${n} ${unit}${n === 1 ? "" : "s"}`;
  }
  return "less than a minute";
}

/** {join_source}: how a member got in, in words. */
export function describeJoinSource(
  source: JoinSource,
  details: { inviterName?: string | null; linkName?: string | null } = {},
): string {
  switch (source) {
    case "invite":
      return details.inviterName ? `an invite from ${details.inviterName}` : "an invite";
    case "vanity":
      return "the vanity URL";
    case "tracked":
      return details.linkName ? `a tracked link: ${details.linkName}` : "a tracked link";
    case "oauth":
      return "a bot invite";
    default:
      return "an unknown invite";
  }
}
