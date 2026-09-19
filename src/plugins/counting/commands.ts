import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { getPluginSettings } from "../../core/permissionRoles.js";
import { zCountingConfig } from "../../config/schemas/plugins.js";
import { getCountingState, resetCountingState } from "./functions/store.js";

export const countingCommands: SlashCommandDefinition[] = [
  {
    plugin: "counting",
    data: new SlashCommandBuilder()
      .setName("counting")
      .setDescription("Manage counting channels")
      .addSubcommand((sub) =>
        sub
          .setName("stats")
          .setDescription("Show a counting channel's current count and record")
          .addChannelOption((o) =>
            o
              .setName("channel")
              .setDescription("Channel (defaults to the current channel)")
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("reset")
          .setDescription("Reset a counting channel's count back to its start")
          .addChannelOption((o) =>
            o
              .setName("channel")
              .setDescription("Channel (defaults to the current channel)")
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread),
          ),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;
      const targetChannel = ctx.interaction.options.getChannel("channel") ?? ctx.interaction.channel;

      if (!targetChannel) {
        await ctx.interaction.reply(
          resultReply(ctx.t("counting.noChannelTitle", "No channel"), ctx.t("counting.noChannelBody", "Could not resolve a channel."), ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "stats") {
        const auth = await requirePluginPermission(ctx, "counting", "can_stats");
        if (!auth) return;

        const pluginConfig = zCountingConfig.parse(getPluginSettings(ctx.guildConfig, "counting"));
        const channelConfig = pluginConfig.channels.find((c) => c.channel_id === targetChannel.id);
        if (!channelConfig) {
          await ctx.interaction.reply(
            resultReply(
              ctx.t("counting.notSetUpTitle", "Not a counting channel"),
              ctx.t("counting.notSetUpBody", "{channel} isn't set up for counting.", { channel: `<#${targetChannel.id}>` }),
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "warning" }),
            ),
          );
          return;
        }

        const state = await getCountingState(guildId, targetChannel.id);
        const currentCount = state?.currentCount ?? channelConfig.start_at - channelConfig.step;
        const highestCount = state?.highestCount ?? 0;

        await ctx.interaction.reply(
          resultReply(
            ctx.t("counting.statsTitle", "Counting stats"),
            ctx.t(
              "counting.statsBody",
              "{channel} is at **{count}**. Highest ever: **{highest}**. Next number: **{next}**.",
              {
                channel: `<#${targetChannel.id}>`,
                count: String(currentCount),
                highest: String(highestCount),
                next: String(currentCount + channelConfig.step),
              },
            ),
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      if (sub === "reset") {
        const auth = await requirePluginPermission(ctx, "counting", "can_reset");
        if (!auth) return;

        const pluginConfig = zCountingConfig.parse(getPluginSettings(ctx.guildConfig, "counting"));
        const channelConfig = pluginConfig.channels.find((c) => c.channel_id === targetChannel.id);
        if (!channelConfig) {
          await ctx.interaction.reply(
            resultReply(
              ctx.t("counting.notSetUpTitle", "Not a counting channel"),
              ctx.t("counting.notSetUpBody", "{channel} isn't set up for counting.", { channel: `<#${targetChannel.id}>` }),
              ctx.ephemeral,
              slashResultOptions(ctx, { tone: "warning" }),
            ),
          );
          return;
        }

        const state = await getCountingState(guildId, targetChannel.id);
        await resetCountingState({
          guildId,
          channelId: targetChannel.id,
          resetCount: channelConfig.start_at - channelConfig.step,
          highestCount: state?.highestCount ?? 0,
          now: new Date(),
        });

        await ctx.interaction.reply(
          resultReply(
            ctx.t("counting.resetTitle", "Counting reset"),
            ctx.t("counting.resetBody", "{channel} is back to **{start}**.", {
              channel: `<#${targetChannel.id}>`,
              start: String(channelConfig.start_at),
            }),
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
      }
    },
  },
];
