import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { zAutodeleteConfig } from "../../config/schemas/plugins.js";
import { clearAutodeleteRule, setAutodeleteRule } from "./functions/store.js";

export const autodeleteCommands: SlashCommandDefinition[] = [
  {
    plugin: "autodelete",
    data: new SlashCommandBuilder()
      .setName("autodelete")
      .setDescription("Auto-delete messages in a channel")
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription("Enable auto-delete for a channel")
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Target channel").addChannelTypes(ChannelType.GuildText).setRequired(true),
          )
          .addIntegerOption((o) =>
            o.setName("delay").setDescription("Delay in seconds").setMinValue(1).setMaxValue(604800),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("clear")
          .setDescription("Disable auto-delete for a channel")
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Target channel").addChannelTypes(ChannelType.GuildText).setRequired(true),
          ),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "set") {
        const auth = await requirePluginPermission(ctx, "autodelete", "can_set");
        if (!auth) return;

        const channel = ctx.interaction.options.getChannel("channel", true);
        const config = zAutodeleteConfig.parse(auth.pluginConfig);
        const delay = ctx.interaction.options.getInteger("delay") ?? config.default_delay_seconds;

        await setAutodeleteRule(guildId, channel.id, delay);
        await ctx.interaction.reply(
          resultReply("Auto-delete enabled", `<#${channel.id}> messages will be deleted after **${delay}** seconds.`, ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "clear") {
        const auth = await requirePluginPermission(ctx, "autodelete", "can_clear");
        if (!auth) return;

        const channel = ctx.interaction.options.getChannel("channel", true);
        const cleared = await clearAutodeleteRule(guildId, channel.id);
        if (!cleared) {
          await ctx.interaction.reply(resultReply("Not configured", `<#${channel.id}> has no auto-delete rule.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })));
          return;
        }

        await ctx.interaction.reply(resultReply("Auto-delete disabled", `Auto-delete cleared for <#${channel.id}>.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "unchecked" })));
      }
    },
  },
];
