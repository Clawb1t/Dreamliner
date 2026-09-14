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
        ctx.t("passport.status.title", "Passport status"),
        ctx.client,
        commandHeader(ctx.guildConfig, { emoji: "<:icons_id:1544417556868104274>" }),
      ).addFields(
        embedField(ctx.t("passport.status.member", "Member"), `${user} \`${user.id}\``, false),
        embedField(
          ctx.t("passport.status.verified", "Verified"),
          verified
            ? `<t:${Math.floor(verified.verifiedAt.getTime() / 1000)}:R> (${verified.method})`
            : ctx.t("passport.status.no", "No"),
          true,
        ),
        embedField(
          ctx.t("passport.status.pending", "Pending"),
          pending ? ctx.t("passport.status.waitingToVerify", "Waiting to verify") : ctx.t("passport.status.no", "No"),
          true,
        ),
        embedField(ctx.t("passport.status.page", "Page"), getPassportUrl(guild.id), false),
      );
      await ctx.interaction.reply(embedReply(embed, ctx.ephemeral));
    },
  },
];
