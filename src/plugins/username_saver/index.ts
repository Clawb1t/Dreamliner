import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zUsernameSaverConfig } from "../../config/schemas/plugins.js";
import { configManager } from "../../config/manager.js";
import { pluginEnabled } from "../../core/pluginCommand.js";
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
          if (!guild.members.cache.has(user.id)) continue;
          const guildConfig = await configManager.getEffectiveConfig(guild.id);
          if (!pluginEnabled(guildConfig, "username_saver")) continue;

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
        if (!pluginEnabled(guildConfig, "username_saver")) return;

        await saveUsernameSnapshot(m.id, m.user.username).catch(() => null);
      },
    },
  ],
});
