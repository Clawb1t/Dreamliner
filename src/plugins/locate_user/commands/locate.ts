import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor, trimLines } from "../../../core/embeds.js";

export const locateCommands: SlashCommandDefinition[] = [
  {
    plugin: "locate_user",
    permission: "can_locate",
    data: new SlashCommandBuilder()
      .setName("locate")
      .setDescription("Find which voice channel a member is in")
      .addUserOption((o) => o.setName("user").setDescription("Member to locate").setRequired(true)),
    execute: async (ctx) => {
      const auth = await requirePluginPermission(ctx, "locate_user", "can_locate");
      if (!auth) return;

      const user = ctx.interaction.options.getUser("user", true);
      const member = await ctx.interaction.guild!.members.fetch(user.id).catch(() => null);
      if (!member) {
        await ctx.interaction.reply(
          resultReply("Locate", "That user is not in this server.", ctx.ephemeral, slashResultOptions(ctx)),
        );
        return;
      }

      const voiceChannel = member.voice.channel;
      if (!voiceChannel) {
        await ctx.interaction.reply(
          embedReply(
            setEmbedAuthor(baseEmbed(), "Locate", ctx.client, commandHeader(ctx.guildConfig)).addFields(
              embedField("User", `<@${user.id}>`),
              embedField("Voice", "Not connected to a voice channel."),
            ),
            ctx.ephemeral,
          ),
        );
        return;
      }

      const others =
        voiceChannel.members.size > 1
          ? voiceChannel.members
              .filter((m) => m.id !== user.id)
              .map((m) => `<@${m.id}>`)
              .join(", ")
          : "None";

      await ctx.interaction.reply(
        embedReply(
          setEmbedAuthor(baseEmbed(), "Locate", ctx.client, commandHeader(ctx.guildConfig)).addFields(
            embedField("User", `<@${user.id}>`),
            embedField("Channel", `<#${voiceChannel.id}> (\`${voiceChannel.name}\`)`),
            embedField("Others in channel", trimLines(others)),
          ),
          ctx.ephemeral,
        ),
      );
    },
  },
];
