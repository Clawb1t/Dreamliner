import { Events } from "discord.js";
import { definePlugin } from "../../core/plugin.js";
import { zStatsConfig } from "../../config/schemas/plugins.js";
import { configManager } from "../../config/manager.js";
import { pluginEnabled } from "../../core/pluginCommand.js";
import { registerIntervalTask } from "../../core/scheduler.js";
import { statsCommands } from "./commands/stats.js";
import {
  incrementDailyStat,
  incrementHourlyBucketStat,
  pruneOldHourlyBuckets,
  recordMessageActivity,
} from "./functions/daily.js";
import { handleVoiceStateUpdate, snapshotActiveVoiceMembers, startVoiceHourlySampler } from "./functions/voice.js";

async function statsActive(guildId: string): Promise<boolean> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  return pluginEnabled(guildConfig, "stats");
}

export const statsPlugin = definePlugin({
  name: "stats",
  configSchema: zStatsConfig,
  slashCommands: statsCommands,
  events: [
    {
      name: Events.MessageCreate,
      execute: async (_client, message: unknown) => {
        const msg = message as import("discord.js").Message;
        if (!msg.guild || msg.author.bot || !msg.channelId) return;
        if (!(await statsActive(msg.guild.id))) return;
        await recordMessageActivity(
          msg.guild.id,
          msg.author.id,
          msg.channelId,
          msg.attachments.size,
          msg.content,
        ).catch(() => null);
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
        if (!(await statsActive(next.guild.id))) return;
        await Promise.all([
          incrementDailyStat(next.guild.id, "edits").catch(() => null),
          incrementHourlyBucketStat(next.guild.id, "edits").catch(() => null),
        ]);
      },
    },
    {
      name: Events.MessageDelete,
      execute: async (_client, message: unknown) => {
        const msg = message as import("discord.js").Message | import("discord.js").PartialMessage;
        if (!msg.guild || !msg.author || msg.author.bot) return;
        if (!(await statsActive(msg.guild.id))) return;
        await Promise.all([
          incrementDailyStat(msg.guild.id, "deletes").catch(() => null),
          incrementHourlyBucketStat(msg.guild.id, "deletes").catch(() => null),
        ]);
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
        if (!(await statsActive(message.guild.id))) return;
        await Promise.all([
          incrementDailyStat(message.guild.id, "reactions").catch(() => null),
          incrementHourlyBucketStat(message.guild.id, "reactions").catch(() => null),
        ]);
      },
    },
    {
      name: Events.GuildMemberAdd,
      execute: async (_client, member: unknown) => {
        const m = member as import("discord.js").GuildMember;
        if (!m.guild || m.user.bot) return;
        if (!(await statsActive(m.guild.id))) return;
        await Promise.all([
          incrementDailyStat(m.guild.id, "joins").catch(() => null),
          incrementHourlyBucketStat(m.guild.id, "joins").catch(() => null),
        ]);
      },
    },
    {
      name: Events.GuildMemberRemove,
      execute: async (_client, member: unknown) => {
        const m = member as import("discord.js").GuildMember;
        if (!m.guild || m.user.bot) return;
        if (!(await statsActive(m.guild.id))) return;
        await Promise.all([
          incrementDailyStat(m.guild.id, "leaves").catch(() => null),
          incrementHourlyBucketStat(m.guild.id, "leaves").catch(() => null),
        ]);
      },
    },
    {
      name: Events.VoiceStateUpdate,
      execute: async (_client, oldState: unknown, newState: unknown) => {
        const oldVoiceState = oldState as import("discord.js").VoiceState;
        const newVoiceState = newState as import("discord.js").VoiceState;
        await handleVoiceStateUpdate(oldVoiceState, newVoiceState);
      },
    },
  ],
  onLoad: async (ctx) => {
    // Restart recovery: seed an in-memory session for anyone already sitting in a voice channel
    // in any guild the bot is in, recovering their real join time from the durable session table
    // where possible. Voice tracking has no per-guild opt-out — see the VoiceStateUpdate handler.
    await snapshotActiveVoiceMembers(ctx.client);
    startVoiceHourlySampler();

    await pruneOldHourlyBuckets().catch(() => null);
    registerIntervalTask({
      id: "stats:prune-hourly-buckets",
      intervalMs: 60 * 60_000,
      run: () => pruneOldHourlyBuckets(),
    });
  },
});
