import type { Guild, GuildMember, User } from "discord.js";

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

export function formatReason(reason: string | null | undefined): string {
  return reason?.trim() || "No reason provided.";
}
