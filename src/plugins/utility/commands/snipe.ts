import { SlashCommandBuilder } from "discord.js";
import type { SlashCommandDefinition } from "../../../core/types.js";
import { baseEmbed, commandHeader, discordTs, embedField, setEmbedAuthor } from "../../../core/embeds.js";
import { embedEdit, resultEdit, slashResultOptions, deferReplyOptions } from "../../../core/responses.js";
import { requireUtilityPermission } from "../functions/commandHelpers.js";
import { getSnipe } from "../functions/snipe.js";

export const snipeCommands: SlashCommandDefinition[] = [
  {
    plugin: "utility",
    permission: "can_snipe",
    data: new SlashCommandBuilder()
      .setName("snipe")
      .setDescription("Show the most recently deleted message in this channel"),
    execute: async (ctx) => {
      const auth = await requireUtilityPermission(ctx, "can_snipe");
      if (!auth) return;
      const { interaction, guildConfig, client } = ctx;
      await interaction.deferReply(deferReplyOptions(ctx.ephemeral));

      const result = getSnipe(interaction.channelId);

      if (!result.found) {
        if (result.lastDeletedAt) {
          await interaction.editReply(
            resultEdit(
              ctx.t("utility.snipe.tooLateTitle", "Too late to snipe"),
              ctx.t(
                "utility.snipe.tooLateBody",
                "The last deleted message in this channel was removed {ts}. /snipe only works within 5 minutes of a deletion.",
                { ts: discordTs(new Date(result.lastDeletedAt)) },
              ),
              slashResultOptions(ctx, { tone: "warning" }),
            ),
          );
          return;
        }

        await interaction.editReply(
          resultEdit(
            ctx.t("utility.snipe.nothingToSnipeTitle", "Nothing to snipe"),
            ctx.t("utility.snipe.nothingToSnipeBody", "No message has been deleted in this channel recently."),
            slashResultOptions(ctx, { tone: "neutral" }),
          ),
        );
        return;
      }

      const sniped = result.message;
      const container = setEmbedAuthor(
        baseEmbed(),
        ctx.t("utility.snipe.snipedMessageTitle", "Sniped message"),
        client,
        commandHeader(guildConfig, {
          thumbnailURL: sniped.authorAvatarUrl,
          emoji: "<:icons_message:1544417564447350804>",
        }),
      );

      container.setDescription(sniped.content || ctx.t("utility.snipe.noTextContent", "*No text content.*"));
      container.addFields(
        embedField(ctx.t("utility.snipe.authorLabel", "Author"), `${sniped.authorTag} (<@${sniped.authorId}>)`, true),
        embedField(ctx.t("utility.snipe.deletedLabel", "Deleted"), discordTs(new Date(sniped.deletedAt)), true),
      );

      if (sniped.attachmentUrls.length > 0) {
        container.addFields(embedField(ctx.t("utility.snipe.attachmentsLabel", "Attachments"), sniped.attachmentUrls.join("\n")));
        const firstUrl = sniped.attachmentUrls[0];
        if (firstUrl && /\.(png|jpe?g|gif|webp)$/i.test(firstUrl)) {
          container.setImage(firstUrl);
        }
      }

      await interaction.editReply(embedEdit(container));
    },
  },
];
