import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
} from "discord.js";
import { configManager } from "../../../config/manager.js";
import { trimLines } from "../../../core/embeds.js";
import { guildResultOptions, resultEdit, resultReply } from "../../../core/responses.js";

export const QUOTE_REMOVE_PREFIX = "utility:quote:remove:";

export function quoteRemoveCustomId(authorId: string): string {
  return `${QUOTE_REMOVE_PREFIX}${authorId}`;
}

export function parseQuoteRemoveAuthorId(customId: string): string | null {
  if (!customId.startsWith(QUOTE_REMOVE_PREFIX)) return null;
  const authorId = customId.slice(QUOTE_REMOVE_PREFIX.length);
  return /^\d{17,20}$/.test(authorId) ? authorId : null;
}

export function buildQuoteRemoveRow(authorId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(quoteRemoveCustomId(authorId))
      .setLabel("Remove my quote")
      .setStyle(ButtonStyle.Secondary),
  );
}

export async function handleQuoteRemoveButtonInteraction(
  interaction: ButtonInteraction,
): Promise<boolean> {
  const quotedAuthorId = parseQuoteRemoveAuthorId(interaction.customId);
  if (!quotedAuthorId) return false;

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply(resultReply("Server only", "Use this in a server.", true));
    return true;
  }

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);

  if (interaction.user.id !== quotedAuthorId) {
    await interaction.reply(
      resultReply(
        "Not your quote",
        "Only the person who was quoted can remove this image.",
        true,
        guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
      ),
    );
    return true;
  }

  const removalDetails = trimLines(`
    <@!${interaction.user.id}> has requested their quote be removed.
  `);

  await interaction
    .update({
      ...resultEdit(
        "Quote removed",
        removalDetails,
        guildResultOptions(interaction.client, guildConfig, { tone: "neutral" }),
      ),
      content: "",
      files: [],
      components: [],
    })
    .catch(async () => {
      await interaction
        .reply(
          resultReply(
            "Could not update",
            "That quote message may have been deleted.",
            true,
            guildResultOptions(interaction.client, guildConfig, { tone: "error" }),
          ),
        )
        .catch(() => null);
    });

  return true;
}
