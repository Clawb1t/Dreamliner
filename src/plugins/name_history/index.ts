import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zNameHistoryConfig } from "../../config/schemas/plugins.js";
import { nameHistoryDefaultOverrides } from "./defaultOverrides.js";
import { namesCommands } from "./commands/names.js";
import { recordNameChange } from "./functions/store.js";

export const nameHistoryPlugin = definePlugin({
  name: "name_history",
  configSchema: zNameHistoryConfig,
  defaultOverrides: nameHistoryDefaultOverrides,
  slashCommands: namesCommands,
  events: [
    {
      name: Events.GuildMemberUpdate,
      execute: async (_client, oldMember: unknown, newMember: unknown) => {
        const oldM = oldMember as import("discord.js").GuildMember;
        const newM = newMember as import("discord.js").GuildMember;
        if (!newM.guild || newM.user.bot) return;

        const oldNick = oldM.nickname ?? oldM.user.username;
        const newNick = newM.nickname ?? newM.user.username;
        if (oldNick === newNick) return;

        await recordNameChange({
          guildId: newM.guild.id,
          userId: newM.id,
          oldName: oldNick,
          newName: newNick,
          changeType: "nickname",
        }).catch(() => null);
      },
    },
    {
      name: Events.UserUpdate,
      execute: async (client, oldUser: unknown, newUser: unknown) => {
        const oldU = oldUser as import("discord.js").User;
        const newU = newUser as import("discord.js").User;
        if (oldU.bot || newU.bot) return;
        if (oldU.username === newU.username) return;

        for (const [, guild] of client.guilds.cache) {
          const member = guild.members.cache.get(newU.id);
          if (!member) continue;
          await recordNameChange({
            guildId: guild.id,
            userId: newU.id,
            oldName: oldU.username,
            newName: newU.username,
            changeType: "username",
          }).catch(() => null);
        }
      },
    },
  ],
});
