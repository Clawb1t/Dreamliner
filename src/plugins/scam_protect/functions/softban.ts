import { PermissionFlagsBits, type Guild, type User } from "discord.js";
import type { Client } from "discord.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { getPluginSettings } from "../../../core/permissionRoles.js";
import { createInfraction, postCaseLog } from "../../infraction/functions/infractions.js";
import { formatReason } from "../../infraction/functions/moderation.js";
import type { InfractionConfig } from "../../../config/schemas/infraction.js";

export async function softbanForScamProtect(options: {
  client: Client;
  guild: Guild;
  guildConfig: GuildConfig;
  user: User;
  reason?: string;
}): Promise<{ ok: true; caseId: number } | { ok: false; error: string }> {
  const { client, guild, guildConfig, user } = options;
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.BanMembers)) {
    return { ok: false, error: "Bot lacks Ban Members permission." };
  }

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (member) {
    if (member.id === guild.ownerId) {
      return { ok: false, error: "Cannot softban the server owner." };
    }
    if (me.roles.highest.position <= member.roles.highest.position) {
      return { ok: false, error: "Bot role is too low to softban that member." };
    }
  }

  const pluginConfig = getPluginSettings(guildConfig, "infractions") as InfractionConfig;
  const deleteDays = Math.min(7, Math.max(0, pluginConfig.softban_delete_message_days ?? 7));
  const reason = formatReason(
    options.reason ?? "Scam Protect: posted in the honeypot channel",
  );

  try {
    await guild.members.ban(user.id, {
      reason,
      deleteMessageSeconds: deleteDays * 86400,
    });
    await guild.members.unban(user.id, "Scam Protect softban");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Softban failed.";
    return { ok: false, error: message };
  }

  const record = await createInfraction({
    guildId: guild.id,
    userId: user.id,
    modId: client.user!.id,
    type: "softban",
    reason,
    active: false,
    metadata: { source: "scam_protect" },
  });

  await postCaseLog(client, guildConfig, pluginConfig, record, user, client.user).catch(() => null);
  return { ok: true, caseId: record.id };
}
