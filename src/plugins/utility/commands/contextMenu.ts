import {
  ApplicationCommandType,
  AttachmentBuilder,
  ContextMenuCommandBuilder,
} from "discord.js";
import { resolveEmojiForContent } from "../../../core/emoji.js";
import type { ContextMenuCommandDefinition } from "../../../core/types.js";
import { convertAttachmentToGif } from "../functions/convertToGif.js";
import { replyContextMenuError } from "../functions/contextMenuHelpers.js";
import { getImageAttachments } from "../functions/imageAttachments.js";
import { buildQuoteRemoveRow } from "../functions/quoteRemoveButton.js";
import { QUOTE_CARD_FILENAME, renderQuoteCard } from "../functions/renderQuoteCard.js";

const MAX_GIF_ATTACHMENTS = 10;

export const contextMenuCommands: ContextMenuCommandDefinition[] = [
  {
    plugin: "utility",
    permission: "can_convert_gif",
    data: new ContextMenuCommandBuilder()
      .setName("Convert to GIF")
      .setType(ApplicationCommandType.Message),
    execute: async (ctx) => {
      const { interaction, guildConfig, client } = ctx;
      await interaction.deferReply();

      const imageAttachments = getImageAttachments(interaction.targetMessage.attachments);
      if (imageAttachments.length === 0) {
        await replyContextMenuError(ctx, "No images", "That message has no image attachments.");
        return;
      }

      const toConvert = imageAttachments.slice(0, MAX_GIF_ATTACHMENTS);
      try {
        const files = await Promise.all(
          toConvert.map((attachment, index) => convertAttachmentToGif(attachment, index)),
        );

        const successEmoji = resolveEmojiForContent(guildConfig.emojis.success, client);
        await interaction.editReply({
          content: `${successEmoji} Hover over the GIF and click the favorite button to add it to your favorites.`,
          files,
        });
      } catch (error) {
        console.error("Convert to GIF error:", error);
        await replyContextMenuError(ctx, "Conversion failed", "Could not convert those images to GIFs.");
      }
    },
  },
  {
    plugin: "utility",
    permission: "can_create_quote",
    data: new ContextMenuCommandBuilder()
      .setName("Create Quote")
      .setType(ApplicationCommandType.Message),
    execute: async (ctx) => {
      const { interaction } = ctx;
      await interaction.deferReply();

      const quoteText = interaction.targetMessage.content.trim();
      if (!quoteText) {
        await replyContextMenuError(ctx, "No text", "That message has no text to quote.");
        return;
      }

      try {
        const author = interaction.targetMessage.author;
        const buffer = await renderQuoteCard(author, quoteText);
        const file = new AttachmentBuilder(buffer, { name: QUOTE_CARD_FILENAME });
        await interaction.editReply({
          files: [file],
          components: [buildQuoteRemoveRow(author.id)],
        });
      } catch (error) {
        console.error("Create Quote error:", error);
        await replyContextMenuError(ctx, "Quote failed", "Could not create that quote image.");
      }
    },
  },
];
