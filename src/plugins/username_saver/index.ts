import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zUsernameSaverConfig } from "../../config/schemas/plugins.js";
import { configManager } from "../../config/manager.js";
import { resolvePluginConfig } from "../../core/permissions.js";
import { saveUsernameSnapshot } from "./functions/store.js";

export const usernameSaverPlugin = definePlugin({
  name: "username_saver",
  configSchema: zUsernameSaverConfig,
  slashCommands: [],
  events: [
    {
      name: Events.UserUpdate,
      execute: async (_client, _oldUser: unknown, newUser: unknown) => {
        const user = newUser as import("discord.js").User;
        if (user.bot) return;

        for (const [, guild] of user.client.guilds.cache) {
          const guildConfig = await configManager.getEffectiveConfig(guild.id);
          const pluginConfig = resolvePluginConfig(guildConfig, "username_saver");
          if (pluginConfig.enabled === false) continue;
          if (!guild.members.cache.has(user.id)) continue;

          await saveUsernameSnapshot(user.id, user.username).catch(() => null);
          return;
        }
      },
    },
    {
      name: Events.GuildMemberAdd,
      execute: async (_client, member: unknown) => {
        const m = member as import("discord.js").GuildMember;
        if (!m.guild || m.user.bot) return;
        const guildConfig = await configManager.getEffectiveConfig(m.guild.id);
        const pluginConfig = resolvePluginConfig(guildConfig, "username_saver");
        if (pluginConfig.enabled === false) return;

        await saveUsernameSnapshot(m.id, m.user.username).catch(() => null);
      },
    },
  ],
});
