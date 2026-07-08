import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zAutoroleConfig, type AutoroleConfig } from "../../config/schemas/autorole.js";
import { configManager } from "../../config/manager.js";
import { getAutorolePluginConfig } from "../../core/guildHelpers.js";
import { scheduleAutoroles } from "./functions/applyRoles.js";

export const autorolePlugin = definePlugin({
  name: "autorole",
  configSchema: zAutoroleConfig,
  slashCommands: [],
  events: [
    {
      name: Events.GuildMemberAdd,
      execute: async (_client, member: unknown) => {
        const m = member as import("discord.js").GuildMember;
        if (!m.guild || m.user.bot) return;

        const guildConfig = await configManager.getEffectiveConfig(m.guild.id);
        const section = guildConfig.plugins.autorole;
        if (section?.enabled === false) return;

        const pluginConfig = getAutorolePluginConfig(guildConfig) as AutoroleConfig;
        scheduleAutoroles(m, pluginConfig);
      },
    },
  ],
});
