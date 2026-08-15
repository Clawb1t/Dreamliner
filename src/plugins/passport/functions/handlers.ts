import type { GuildMember, PartialGuildMember } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { getPassportConfig, isPassportEnabled } from "./loadConfig.js";
import {
  applyUnverifiedGate,
  applyVerifiedRewards,
  memberHasBypassRole,
} from "./roles.js";
import { deletePassportMessage, dmPassportLink, postPassportPing } from "./delivery.js";
import {
  deletePassportPending,
  getPassportPending,
  getPassportVerification,
  upsertPassportPending,
} from "./store.js";

function timeoutExpiry(timeoutSeconds: number, action: string): Date | null {
  if (action !== "kick" || timeoutSeconds <= 0) return null;
  return new Date(Date.now() + timeoutSeconds * 1000);
}

export async function handlePassportMemberAdd(member: GuildMember): Promise<void> {
  if (!member.guild || member.user.bot) return;

  const guildConfig = await configManager.getEffectiveConfig(member.guild.id);
  if (!isPassportEnabled(guildConfig)) return;

  const config = getPassportConfig(guildConfig);
  if (memberHasBypassRole(member, config)) return;

  const remembered =
    config.remember_verifications &&
    Boolean(await getPassportVerification(member.guild.id, member.id));

  if (remembered) {
    await applyVerifiedRewards(member, config);
    await deletePassportPending(member.guild.id, member.id);
    return;
  }

  await applyUnverifiedGate(member, config);

  let ping: { messageId: string; channelId: string } | null = null;
  if (config.ping.enabled) {
    ping = await postPassportPing(member, config);
    await dmPassportLink(member, config);
    if (ping && config.ping.delete_after_seconds > 0) {
      const { guild } = member;
      const pingRef = ping;
      const delayMs = config.ping.delete_after_seconds * 1000;
      setTimeout(() => {
        void deletePassportMessage(guild, pingRef.channelId, pingRef.messageId);
      }, delayMs);
    }
  }

  await upsertPassportPending({
    guildId: member.guild.id,
    userId: member.id,
    joinedAt: new Date(),
    expiresAt: timeoutExpiry(config.timeout_seconds, config.timeout_action),
    pingMessageId: ping?.messageId ?? null,
    pingChannelId: ping?.channelId ?? null,
  });
}

export async function handlePassportMemberRemove(
  member: GuildMember | PartialGuildMember,
): Promise<void> {
  const guild = member.guild;
  if (!guild) return;

  const guildConfig = await configManager.getEffectiveConfig(guild.id);
  if (!isPassportEnabled(guildConfig)) return;
  const config = getPassportConfig(guildConfig);

  const pending = await getPassportPending(guild.id, member.id);
  if (pending && config.ping.delete_on_leave) {
    await deletePassportMessage(guild, pending.pingChannelId, pending.pingMessageId);
  }
  await deletePassportPending(guild.id, member.id);
}
