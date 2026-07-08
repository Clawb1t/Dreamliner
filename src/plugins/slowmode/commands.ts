import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
export const slowmodeCommands: SlashCommandDefinition[] = [
  {
    plugin: "slowmode",
    discordPermissions: PermissionFlagsBits.ManageChannels,
    data: new SlashCommandBuilder()
      .setName("slowmode")
      .setDescription("Manage channel slowmode")
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription("Set slowmode for a channel")
          .addIntegerOption((o) =>
            o.setName("seconds").setDescription("Slowmode delay in seconds (0–21600)").setRequired(true).setMinValue(0).setMaxValue(21600),
          )
          .addChannelOption((o) => o.setName("channel").setDescription("Channel (defaults to current)")),
      )
      .addSubcommand((sub) =>
        sub
          .setName("clear")
          .setDescription("Clear slowmode for a channel")
          .addChannelOption((o) => o.setName("channel").setDescription("Channel (defaults to current)")),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const auth = await requirePluginPermission(ctx, "slowmode", sub === "set" ? "can_set" : "can_clear");
      if (!auth) return;

      const channelRef = ctx.interaction.options.getChannel("channel") ?? ctx.interaction.channel;
      if (!channelRef) {
        await ctx.interaction.reply(
          resultReply("Slowmode", "Select a valid text channel.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }

      const channel = await ctx.interaction.guild!.channels.fetch(channelRef.id).catch(() => null);
      if (!channel?.isTextBased() || channel.isDMBased() || !("setRateLimitPerUser" in channel)) {
        await ctx.interaction.reply(
          resultReply("Slowmode", "Select a valid text channel.", ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })),
        );
        return;
      }

      const seconds = sub === "set" ? ctx.interaction.options.getInteger("seconds", true) : 0;

      await channel.setRateLimitPerUser(seconds, `Slowmode ${sub} by ${ctx.interaction.user.tag}`);

      if (sub === "set") {
        await ctx.interaction.reply(
          resultReply(
            "Slowmode set",
            `<#${channel.id}> slowmode set to **${seconds}** second(s).`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      await ctx.interaction.reply(
        resultReply("Slowmode cleared", `<#${channel.id}> slowmode disabled.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "unchecked" })),
      );
    },
  },
];
