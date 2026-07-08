import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zStatsConfig } from "../../config/schemas/plugins.js";
import { statsDefaultOverrides } from "./defaultOverrides.js";
import { statsCommands } from "./commands/stats.js";
import { incrementDailyStat } from "./functions/daily.js";

export const statsPlugin = definePlugin({
  name: "stats",
  configSchema: zStatsConfig,
  defaultOverrides: statsDefaultOverrides,
  slashCommands: statsCommands,
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        const msg = message as import("discord.js").Message;
        if (!msg.guild || msg.author.bot) return;
        await incrementDailyStat(msg.guild.id, "messages").catch(() => null);
      },
    },
    {
      name: Events.GuildMemberAdd,
      execute: async (_client, member: unknown) => {
        const m = member as import("discord.js").GuildMember;
        if (!m.guild || m.user.bot) return;
        await incrementDailyStat(m.guild.id, "joins").catch(() => null);
      },
    },
    {
      name: Events.GuildMemberRemove,
      execute: async (_client, member: unknown) => {
        const m = member as import("discord.js").GuildMember;
        if (!m.guild || m.user.bot) return;
        await incrementDailyStat(m.guild.id, "leaves").catch(() => null);
      },
    },
  ],
});
