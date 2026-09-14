import type { Guild, GuildMember, User } from "discord.js";
import type { Translator } from "../../../i18n/index.js";

export function canModerateTarget(
  actor: GuildMember,
  target: GuildMember | null,
  targetUser: User,
  guild: Guild,
  t: Translator,
): string | null {
  if (targetUser.id === actor.id) {
    return t("infraction.cannotModerateSelf", "You cannot moderate yourself.");
  }
  if (targetUser.id === guild.client.user?.id) {
    return t("infraction.cannotModerateBot", "You cannot moderate the bot.");
  }
  if (target && target.roles.highest.position >= actor.roles.highest.position && guild.ownerId !== actor.id) {
    return t("infraction.cannotModerateHigherRole", "You cannot moderate a member with an equal or higher role.");
  }
  const me = guild.members.me;
  if (!me) return t("infraction.botMemberNotFound", "Bot member not found.");
  if (target && !target.manageable) {
    return t("infraction.cannotModerateHierarchy", "I cannot moderate that member (role hierarchy).");
  }
  return null;
}

export function formatReason(reason: string | null | undefined): string {
  return reason?.trim() || "No reason provided.";
}
