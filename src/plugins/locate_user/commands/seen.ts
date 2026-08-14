import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { embedReply, resultReply, slashResultOptions } from "../../../core/responses.js";
import { requirePluginPermission } from "../../../core/pluginCommand.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor } from "../../../core/embeds.js";
import { discordTimestampBoth } from "../../../core/datetime.js";
import { getLastSeen } from "../functions/lastSeen.js";

export const seenCommands: SlashCommandDefinition[] = [
  {
    plugin: "locate_user",
    permission: "can_seen",
    data: new SlashCommandBuilder()
      .setName("seen")
      .setDescription("Show when a member was last seen in this server")
      .addUserOption((o) => o.setName("user").setDescription("Member to look up").setRequired(true)),
    execute: async (ctx) => {
      const auth = await requirePluginPermission(ctx, "locate_user", "can_seen");
      if (!auth) return;

      const user = ctx.interaction.options.getUser("user", true);
      const guild = ctx.interaction.guild!;
      const [member, lastSeen] = await Promise.all([
        guild.members.fetch(user.id).catch(() => null),
        getLastSeen(guild.id, user.id),
      ]);

      if (!lastSeen) {
        await ctx.interaction.reply(
          resultReply(
            "Seen",
            `No recorded activity for <@${user.id}> in this server.`,
            ctx.ephemeral,
            slashResultOptions(ctx),
          ),
        );
        return;
      }

      const voiceChannel = member?.voice.channel;
      const embed = setEmbedAuthor(baseEmbed(), "Seen", ctx.client, commandHeader(ctx.guildConfig)).addFields(
        embedField("User", `<@${user.id}>`),
        embedField("Last seen", discordTimestampBoth(lastSeen.at)),
        embedField("Activity", lastSeen.action),
      );
      if (voiceChannel) {
        embed.addFields(embedField("Currently", `In <#${voiceChannel.id}>`));
      }

      await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
    },
  },
];
