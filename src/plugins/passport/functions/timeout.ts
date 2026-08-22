import type { Client } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { emitLog } from "../../../core/logging/send.js";
import { renderTemplate } from "../../../core/templates.js";
import { deletePassportMessage } from "./delivery.js";
import { getPassportConfig, isPassportEnabled } from "./loadConfig.js";
import { deletePassportPending, listExpiredPassportPending } from "./store.js";

export async function processExpiredPassports(client: Client): Promise<void> {
  const expired = await listExpiredPassportPending();
  for (const row of expired) {
    const guild = client.guilds.cache.get(row.guildId);
    if (!guild) continue;

    const guildConfig = await configManager.getEffectiveConfig(guild.id);
    if (!isPassportEnabled(guildConfig)) {
      await deletePassportPending(row.guildId, row.userId);
      continue;
    }
    const config = getPassportConfig(guildConfig);
    if (config.timeout_action !== "kick") {
      await deletePassportPending(row.guildId, row.userId);
      continue;
    }

    const member = await guild.members.fetch(row.userId).catch(() => null);
    if (!member) {
      await deletePassportPending(row.guildId, row.userId);
      continue;
    }

    const dm = config.timeout_dm.trim();
    if (dm) {
      const content = renderTemplate(dm, {
        member,
        user: member.user,
        guild,
      }).trim();
      if (content) await member.send({ content }).catch(() => null);
    }

    await deletePassportMessage(guild, row.pingChannelId, row.pingMessageId);
    const kicked = await member.kick("Passport verification timed out").then(() => true).catch(() => false);
    await deletePassportPending(row.guildId, row.userId);

    if (kicked) {
      await emitLog(
        client,
        guildConfig,
        {
          title: "Passport kick",
          avatarUrl: member.user.displayAvatarURL({ size: 64 }),
          information: [
            `**Member:** ${member} \`${member.id}\``,
            "**Reason:** Did not finish verification in time.",
          ],
          emojiCategory: "modSevere",
        },
        {
          guildId: guild.id,
          eventType: "passport_kick",
          summary: `${member.user.tag} was kicked for not verifying.`,
          actorId: client.user?.id ?? null,
          targetId: member.id,
        },
      );
    }
  }
}
