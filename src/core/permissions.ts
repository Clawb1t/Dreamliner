import type { GuildMember } from "discord.js";
import type { ConfigOverride } from "./types.js";
import type { GuildConfig } from "../config/schemas/guild.js";
import { getPluginBaseConfig } from "./pluginSchemas.js";

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

  return config;
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
