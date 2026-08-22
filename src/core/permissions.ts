import { PermissionFlagsBits, type GuildMember } from "discord.js";
import type { ConfigOverride } from "./types.js";
import type { GuildConfig } from "../config/schemas/guild.js";
import { getPluginBaseConfig, stripUnknownPluginKeys } from "./pluginSchemas.js";

/**
 * The built-in "admin tier" every plugin's default overrides top out at (see each plugin's
 * defaultOverrides.ts). Discord Administrator / Manage Server holders always reach at least
 * this level so a freshly-invited bot with an empty `levels: {}` map isn't locked out of every
 * command until someone manually maps role/user IDs.
 */
const ADMIN_TIER_LEVEL = 100;

function parseLevelRequirement(level: string): { op: ">=" | ">" | "<=" | "<" | "="; value: number } | null {
  const match = level.match(/^(>=|>|<=|<|=)(\d+)$/);
  if (!match) return null;
  return { op: match[1] as ">=" | ">" | "<=" | "<" | "=", value: Number(match[2]) };
}

function compareLevel(memberLevel: number, req: { op: string; value: number }): boolean {
  switch (req.op) {
    case ">=":
      return memberLevel >= req.value;
    case ">":
      return memberLevel > req.value;
    case "<=":
      return memberLevel <= req.value;
    case "<":
      return memberLevel < req.value;
    case "=":
      return memberLevel === req.value;
    default:
      return false;
  }
}

export function getMemberLevel(member: GuildMember, levels: Record<string, number>): number {
  let maxLevel = 0;

  if (levels[member.id]) {
    maxLevel = Math.max(maxLevel, levels[member.id]);
  }

  for (const role of member.roles.cache.values()) {
    if (levels[role.id]) {
      maxLevel = Math.max(maxLevel, levels[role.id]);
    }
  }

  // Owner and Discord Administrator / Manage Server holders always reach the admin tier, even
  // with no `levels` entries configured. An explicit `levels` entry can only raise this further,
  // never lower it below the admin tier.
  if (
    member.id === member.guild.ownerId ||
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  ) {
    maxLevel = Math.max(maxLevel, ADMIN_TIER_LEVEL);
  }

  return maxLevel;
}

function overrideMatches(
  override: ConfigOverride,
  member: GuildMember,
  channelId: string,
  categoryId: string | null | undefined,
  memberLevel: number,
): boolean {
  if (override.user && override.user !== member.id) return false;
  if (override.role && !member.roles.cache.has(override.role)) return false;
  if (override.channel && override.channel !== channelId) return false;
  if (override.category && override.category !== categoryId) return false;
  if (override.level) {
    const req = parseLevelRequirement(override.level);
    if (!req || !compareLevel(memberLevel, req)) return false;
  }
  return true;
}

export function resolvePluginConfig(
  guildConfig: GuildConfig,
  pluginName: string,
  defaultOverrides: ConfigOverride[] = [],
  member?: GuildMember,
  channelId?: string,
  categoryId?: string | null,
): Record<string, unknown> {
  const section = guildConfig.plugins[pluginName as keyof typeof guildConfig.plugins] as
    | {
        config?: Record<string, unknown>;
        overrides?: ConfigOverride[];
        replaceDefaultOverrides?: boolean;
      }
    | undefined;

  const baseSchema = getPluginBaseConfig(pluginName);
  let config: Record<string, unknown> = { ...baseSchema };

  const overrides = section?.replaceDefaultOverrides
    ? (section.overrides ?? [])
    : [...defaultOverrides, ...(section?.overrides ?? [])];

  if (section?.config) {
    Object.assign(config, section.config);
  }

  for (const override of overrides) {
    if (member && channelId !== undefined) {
      const level = getMemberLevel(member, guildConfig.levels);
      if (!overrideMatches(override, member, channelId, categoryId, level)) continue;
    }
    Object.assign(config, override.config);
  }

  return stripUnknownPluginKeys(pluginName, config);
}

export function hasPluginPermission(
  guildConfig: GuildConfig,
  pluginName: string,
  permission: string,
  member: GuildMember,
  channelId: string,
  categoryId?: string | null,
  defaultOverrides: ConfigOverride[] = [],
): boolean {
  const config = resolvePluginConfig(guildConfig, pluginName, defaultOverrides, member, channelId, categoryId);
  return Boolean(config[permission]);
}
