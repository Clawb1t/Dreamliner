import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { isHubChannel, registerHub, unregisterHub } from "./functions/store.js";

export const companionChannelsCommands: SlashCommandDefinition[] = [
  {
    plugin: "companion_channels",
    data: new SlashCommandBuilder()
      .setName("companion")
      .setDescription("Manage companion voice channels")
      .addSubcommand((sub) =>
        sub
          .setName("create")
          .setDescription("Register a hub voice channel")
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Hub voice channel").addChannelTypes(ChannelType.GuildVoice).setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("delete")
          .setDescription("Remove a hub voice channel")
          .addChannelOption((o) =>
            o.setName("channel").setDescription("Hub voice channel").addChannelTypes(ChannelType.GuildVoice).setRequired(true),
          ),
      ),
    execute: async (ctx) => {
      const sub = ctx.interaction.options.getSubcommand();
      const guildId = ctx.interaction.guildId!;

      if (sub === "create") {
        const auth = await requirePluginPermission(ctx, "companion_channels", "can_create");
        if (!auth) return;

        const channel = ctx.interaction.options.getChannel("channel", true);
        if (await isHubChannel(guildId, channel.id)) {
          await ctx.interaction.reply(resultReply("Already registered", `<#${channel.id}> is already a hub.`, ctx.ephemeral, slashResultOptions(ctx, { tone: "warning" })));
          return;
        }

        await registerHub(guildId, channel.id);
        await ctx.interaction.reply(
          resultReply("Hub registered", `<#${channel.id}> will create companion channels when joined.`, ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      if (sub === "delete") {
        const auth = await requirePluginPermission(ctx, "companion_channels", "can_delete");
        if (!auth) return;

        const channel = ctx.interaction.options.getChannel("channel", true);
        const removed = await unregisterHub(guildId, channel.id);
        if (!removed) {
          await ctx.interaction.reply(resultReply("Not found", `<#${channel.id}> is not a registered hub.`, ctx.ephemeral, slashResultOptions(ctx)));
          return;
        }

        await ctx.interaction.reply(resultReply("Hub removed", `<#${channel.id}> is no longer a hub.`, ctx.ephemeral, slashResultOptions(ctx)));
      }
    },
  },
];
