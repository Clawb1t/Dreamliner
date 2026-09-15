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
        getLastSeen(guild.id, user.id, ctx.t),
      ]);

      if (!lastSeen) {
        await ctx.interaction.reply(
          resultReply(
            ctx.t("locate_user.seenTitle", "Seen"),
            ctx.t("locate_user.noRecordedActivity", "No recorded activity for {user} in this server.", { user: `<@${user.id}>` }),
            ctx.ephemeral,
            slashResultOptions(ctx, { emoji: "<:icons_clock:1544417185336664114>" }),
          ),
        );
        return;
      }

      const voiceChannel = member?.voice.channel;
      const embed = setEmbedAuthor(
        baseEmbed(),
        ctx.t("locate_user.seenTitle", "Seen"),
        ctx.client,
        commandHeader(ctx.guildConfig, { emoji: "<:icons_clock:1544417185336664114>" }),
      ).addFields(
        embedField(ctx.t("locate_user.fieldUser", "User"), `<@${user.id}>`),
        embedField(ctx.t("locate_user.fieldLastSeen", "Last seen"), discordTimestampBoth(lastSeen.at)),
        embedField(ctx.t("locate_user.fieldActivity", "Activity"), lastSeen.action),
      );
      if (voiceChannel) {
        embed.addFields(embedField(ctx.t("locate_user.fieldCurrently", "Currently"), ctx.t("locate_user.inChannel", "In <#{channel}>", { channel: voiceChannel.id })));
      }

      await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
    },
  },
];
