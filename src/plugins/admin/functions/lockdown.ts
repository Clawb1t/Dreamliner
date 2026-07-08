import type { Guild, TextChannel } from "discord.js";
import type { AdminConfig } from "../../../config/schemas/plugins.js";

function getLockdownTargetRoleId(guild: Guild, config: AdminConfig): string {
  return config.lockdown_role_id ?? guild.id;
}

export async function applyLockdown(guild: Guild, config: AdminConfig): Promise<{ updated: number; target: string }> {
  const roleId = getLockdownTargetRoleId(guild, config);
  const role = guild.roles.cache.get(roleId);
  const target = role ? `@${role.name}` : "@everyone";

  let updated = 0;
  for (const channel of guild.channels.cache.values()) {
    if (!channel.isTextBased() || channel.isDMBased()) continue;
    const textChannel = channel as TextChannel;
    await textChannel.permissionOverwrites
      .edit(roleId, { SendMessages: false }, { reason: "Dreamliner lockdown" })
      .catch(() => null);
    updated++;
  }

  return { updated, target };
}

export async function applyUnlock(guild: Guild, config: AdminConfig): Promise<{ updated: number; target: string }> {
  const roleId = getLockdownTargetRoleId(guild, config);
  const role = guild.roles.cache.get(roleId);
  const target = role ? `@${role.name}` : "@everyone";

  let updated = 0;
  for (const channel of guild.channels.cache.values()) {
    if (!channel.isTextBased() || channel.isDMBased()) continue;
    const textChannel = channel as TextChannel;
    const existing = textChannel.permissionOverwrites.cache.get(roleId);
    if (!existing) continue;
    await textChannel.permissionOverwrites
      .edit(roleId, { SendMessages: null }, { reason: "Dreamliner unlock" })
      .catch(() => null);
    updated++;
  }

  return { updated, target };
}
