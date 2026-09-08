import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zInfractionConfig } from "../../config/schemas/infraction.js";
import { actionCommands } from "./commands/actions.js";
import { manageCommands } from "./commands/manage.js";
import { evidenceCommands } from "./commands/evidence.js";
import { processExpiredInfractions } from "./functions/infractions.js";
import { sweepExpiredEvidence } from "../../core/evidence.js";
import { getLogger } from "../../core/logger.js";
const log = getLogger("infraction");

export const infractionPlugin = definePlugin({
  name: "infractions",
  configSchema: zInfractionConfig,
  slashCommands: [...actionCommands, ...manageCommands, ...evidenceCommands],
  onLoad: async ({ client }) => {
    setInterval(() => {
      processExpiredInfractions(client).catch((err) => {
        log.error("Infraction expiration sweep failed:", err);
      });
    }, 60_000);
    setInterval(() => {
      sweepExpiredEvidence().catch((err) => {
        log.error("Evidence retention sweep failed:", err);
      });
    }, 60 * 60_000);
  },
  events: [
    {
      name: Events.GuildMemberUpdate,
      execute: async (_client, oldMember: unknown, newMember: unknown) => {
        const oldM = oldMember as import("discord.js").GuildMember;
        const newM = newMember as import("discord.js").GuildMember;
        if (!newM.guild) return;

        const hadTimeout = Boolean(oldM.communicationDisabledUntilTimestamp);
        const hasTimeout = Boolean(newM.communicationDisabledUntilTimestamp);
        if (hadTimeout && !hasTimeout) {
          const { deactivateInfractions } = await import("./functions/infractions.js");
          await deactivateInfractions(newM.guild.id, newM.id, ["mute", "tempmute"]);
        }
      },
    },
    {
      name: Events.GuildBanRemove,
      execute: async (_client, ban: unknown) => {
        const guildBan = ban as import("discord.js").GuildBan;
        const { deactivateInfractions } = await import("./functions/infractions.js");
        await deactivateInfractions(guildBan.guild.id, guildBan.user.id, ["ban", "tempban"]);
      },
    },
  ],
});
