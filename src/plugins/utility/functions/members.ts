import type { GuildMember } from "discord.js";
import { PermissionFlagsBits } from "discord.js";
import { getMemberLevel } from "../../../core/permissions.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";

export function canActOn(actor: GuildMember, target: GuildMember, guildConfig: GuildConfig): boolean {
  if (actor.id === target.id) return true;
  if (target.id === target.guild.ownerId) return false;
  if (actor.id === actor.guild.ownerId) return true;

  const actorLevel = getMemberLevel(actor, guildConfig.levels);
  const targetLevel = getMemberLevel(target, guildConfig.levels);
  if (actorLevel <= targetLevel) return false;

  if (target.permissions.has(PermissionFlagsBits.Administrator) && !actor.permissions.has(PermissionFlagsBits.Administrator)) {
    return false;
  }

  return actor.permissions.has(PermissionFlagsBits.ModerateMembers) || actorLevel >= 50;
}

export function findVoiceChannelByName(guild: import("discord.js").Guild, name: string) {
  const lower = name.toLowerCase();
  return guild.channels.cache.find(
    (c) => c.isVoiceBased() && c.name.toLowerCase().includes(lower),
  ) ?? null;
}
