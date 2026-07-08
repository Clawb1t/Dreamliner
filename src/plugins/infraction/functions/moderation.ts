import type { Guild, GuildMember, User } from "discord.js";
import type { InfractionConfig } from "../../../config/schemas/infraction.js";
import { getMemberLevel } from "../../../core/permissions.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";

export function canModerateTarget(
  actor: GuildMember,
  target: GuildMember | null,
  targetUser: User,
  guild: Guild,
): string | null {
  if (targetUser.id === actor.id) {
    return "You cannot moderate yourself.";
  }
  if (targetUser.id === guild.client.user?.id) {
    return "You cannot moderate the bot.";
  }
  if (target && target.roles.highest.position >= actor.roles.highest.position && guild.ownerId !== actor.id) {
    return "You cannot moderate a member with an equal or higher role.";
  }
  const me = guild.members.me;
  if (!me) return "Bot member not found.";
  if (target && !target.manageable) {
    return "I cannot moderate that member (role hierarchy).";
  }
  return null;
}

export function canEditInfractionReason(
  guildConfig: GuildConfig,
  pluginConfig: InfractionConfig,
  actor: GuildMember,
  infractionModId: string,
): boolean {
  if (actor.id === infractionModId) return true;
  const level = getMemberLevel(actor, guildConfig.levels);
  return level >= pluginConfig.reason_edit_level;
}

export function canEditInfractionDuration(
  guildConfig: GuildConfig,
  pluginConfig: InfractionConfig,
  actor: GuildMember,
  infractionModId: string,
): boolean {
  if (actor.id === infractionModId) return true;
  const level = getMemberLevel(actor, guildConfig.levels);
  return level >= pluginConfig.duration_edit_level;
}

export function formatReason(reason: string | null | undefined): string {
  return reason?.trim() || "No reason provided.";
}
