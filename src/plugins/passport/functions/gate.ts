import type { GuildMember } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { getPassportConfig, isPassportEnabled } from "./loadConfig.js";
import { memberHasBypassRole } from "./roles.js";
import { getPassportVerification } from "./store.js";

/**
 * Whether this member has already satisfied Passport, or Passport doesn't apply to them at all
 * (disabled, or they bypass it) — for other plugins (e.g. Welcomer's "wait for Passport" toggle)
 * that need to know whether to act now or wait for a verification that will actually happen.
 */
export async function hasMemberPassedPassport(member: GuildMember): Promise<boolean> {
  const guildConfig = await configManager.getEffectiveConfig(member.guild.id);
  if (!isPassportEnabled(guildConfig)) return true;

  const config = getPassportConfig(guildConfig);
  if (memberHasBypassRole(member, config)) return true;

  return Boolean(await getPassportVerification(member.guild.id, member.id));
}
