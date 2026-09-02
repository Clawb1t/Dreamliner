import { AuditLogEvent, Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zNameHistoryConfig } from "../../config/schemas/plugins.js";
import { configManager } from "../../config/manager.js";
import { pluginEnabled } from "../../core/pluginCommand.js";
import { findAuditExecutor } from "../../core/logging/audit.js";
import { namesCommands } from "./commands/names.js";
import { recordNameChange } from "./functions/store.js";

export const nameHistoryPlugin = definePlugin({
  name: "name_history",
  configSchema: zNameHistoryConfig,
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

        const guildConfig = await configManager.getEffectiveConfig(newM.guild.id);
        if (!pluginEnabled(guildConfig, "name_history")) return;

        const mod = await findAuditExecutor(newM.guild, AuditLogEvent.MemberUpdate, {
          targetId: newM.id,
        });

        await recordNameChange({
          guildId: newM.guild.id,
          userId: newM.id,
          oldName: oldNick,
          newName: newNick,
          changeType: "nickname",
          changedBy: mod?.id ?? newM.id,
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
          const guildConfig = await configManager.getEffectiveConfig(guild.id);
          if (!pluginEnabled(guildConfig, "name_history")) continue;
          await recordNameChange({
            guildId: guild.id,
            userId: newU.id,
            oldName: oldU.username,
            newName: newU.username,
            changeType: "username",
            changedBy: newU.id,
          }).catch(() => null);
        }
      },
    },
  ],
});
