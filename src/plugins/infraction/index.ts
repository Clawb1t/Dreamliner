import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zInfractionConfig } from "../../config/schemas/infraction.js";
import { infractionDefaultOverrides } from "./defaultOverrides.js";
import { actionCommands } from "./commands/actions.js";
import { manageCommands } from "./commands/manage.js";
import { processExpiredInfractions } from "./functions/infractions.js";

export const infractionPlugin = definePlugin({
  name: "infractions",
  configSchema: zInfractionConfig,
  defaultOverrides: infractionDefaultOverrides,
  slashCommands: [...actionCommands, ...manageCommands],
  onLoad: async ({ client }) => {
    setInterval(() => {
      processExpiredInfractions(client).catch((err) => {
        console.error("Infraction expiration sweep failed:", err);
      });
    }, 60_000);
  },
  events: [
    {
      name: Events.GuildMemberUpdate,
      execute: async (_client, oldMember: unknown, newMember: unknown) => {
        const oldM = oldMember as import("discord.js").GuildMember;
        const newM = newMember as import("discord.js").GuildMember;
        if (!newM.guild) return;

        const { configManager } = await import("../../config/manager.js");
        const { getInfractionPluginConfig } = await import("../../core/guildHelpers.js");
        const guildConfig = await configManager.getEffectiveConfig(newM.guild.id);
        const pluginConfig = getInfractionPluginConfig(guildConfig) as import("../../config/schemas/infraction.js").InfractionConfig;
        const muteRoleId = pluginConfig.mute_role;
        if (!muteRoleId) return;

        const hadMute = oldM.roles.cache.has(muteRoleId);
        const hasMute = newM.roles.cache.has(muteRoleId);
        if (hadMute && !hasMute) {
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
