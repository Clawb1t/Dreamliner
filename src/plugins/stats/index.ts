import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zStatsConfig } from "../../config/schemas/plugins.js";
import { statsDefaultOverrides } from "./defaultOverrides.js";
import { statsCommands } from "./commands/stats.js";
import { incrementDailyStat, recordMessageActivity } from "./functions/daily.js";

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
        if (!msg.guild || msg.author.bot || !msg.channelId) return;
        await recordMessageActivity(msg.guild.id, msg.author.id, msg.channelId, msg.attachments.size).catch(
          () => null,
        );
      },
    },
    {
      name: Events.MessageUpdate,
      execute: async (_client, oldMessage: unknown, newMessage: unknown) => {
        const prev = oldMessage as import("discord.js").Message | import("discord.js").PartialMessage;
        const next = newMessage as import("discord.js").Message | import("discord.js").PartialMessage;
        if (!next.guild || !next.author || next.author.bot) return;
        const oldContent = "content" in prev ? prev.content : null;
        const newContent = "content" in next ? next.content : null;
        if (oldContent === newContent) return;
        await incrementDailyStat(next.guild.id, "edits").catch(() => null);
      },
    },
    {
      name: Events.MessageDelete,
      execute: async (_client, message: unknown) => {
        const msg = message as import("discord.js").Message | import("discord.js").PartialMessage;
        if (!msg.guild || !msg.author || msg.author.bot) return;
        await incrementDailyStat(msg.guild.id, "deletes").catch(() => null);
      },
    },
    {
      name: Events.MessageReactionAdd,
      execute: async (_client, reaction: unknown, user: unknown) => {
        const react = reaction as import("discord.js").MessageReaction | import("discord.js").PartialMessageReaction;
        const reactUser = user as import("discord.js").User | import("discord.js").PartialUser;
        if (reactUser.bot) return;
        const message = react.message;
        if (!message.guild) return;
        await incrementDailyStat(message.guild.id, "reactions").catch(() => null);
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
