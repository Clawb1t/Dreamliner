import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { embedReply } from "../../core/responses.js";
import { baseEmbed, commandHeader, embedField, setEmbedAuthor } from "../../core/embeds.js";
import { getPassportUrl } from "../../core/docsUrl.js";
import { getPassportPending, getPassportVerification } from "./functions/store.js";

export const passportCommands: SlashCommandDefinition[] = [
  {
    plugin: "passport",
    data: new SlashCommandBuilder()
      .setName("passport")
      .setDescription("Check a member's Passport verification status")
      .addUserOption((o) => o.setName("user").setDescription("Member to look up").setRequired(true)),
    execute: async (ctx) => {
      const auth = await requirePluginPermission(ctx, "passport", "can_test");
      if (!auth) return;

      const guild = ctx.interaction.guild!;
      const user = ctx.interaction.options.getUser("user", true);

      const pending = await getPassportPending(guild.id, user.id);
      const verified = await getPassportVerification(guild.id, user.id);
      const embed = setEmbedAuthor(
        baseEmbed(),
        "Passport status",
        ctx.client,
        commandHeader(ctx.guildConfig, { emoji: "<:icons_id:1544417556868104274>" }),
      ).addFields(
        embedField("Member", `${user} \`${user.id}\``, false),
        embedField(
          "Verified",
          verified
            ? `<t:${Math.floor(verified.verifiedAt.getTime() / 1000)}:R> (${verified.method})`
            : "No",
          true,
        ),
        embedField("Pending", pending ? "Waiting to verify" : "No", true),
        embedField("Page", getPassportUrl(guild.id), false),
      );
      await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
    },
  },
];
