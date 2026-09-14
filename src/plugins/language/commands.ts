import {
  ActionRowBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { APP_EMOJI } from "../../core/appEmojis.js";
import { resultReply, slashResultOptions } from "../../core/responses.js";
import { listEnabledLanguages } from "../../i18n/index.js";
import { LANGUAGE_SELECT_PREFIX } from "./constants.js";

async function buildLanguageRow(current: string): Promise<ActionRowBuilder<StringSelectMenuBuilder>> {
  const languages = await listEnabledLanguages();
  const menu = new StringSelectMenuBuilder()
    .setCustomId(LANGUAGE_SELECT_PREFIX)
    .setPlaceholder("Choose a language…")
    .addOptions(
      languages.map((lang) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(lang.name)
          .setEmoji(lang.flag || "🌐")
          .setValue(lang.code)
          .setDefault(lang.code === current),
      ),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export const languageCommands: SlashCommandDefinition[] = [
  {
    data: new SlashCommandBuilder()
      .setName("language")
      .setDescription("Set the language Dreamliner replies to you in"),
    plugin: "language",
    execute: async (ctx) => {
      const { interaction, ephemeral, locale, t } = ctx;
      await interaction.reply(
        resultReply(
          t("language.title", "Language"),
          t(
            "language.prompt",
            "Pick the language you'd like Dreamliner to reply to **you** with. This only affects you, not the rest of the server.",
          ),
          ephemeral,
          slashResultOptions(ctx, { emoji: APP_EMOJI.globe }),
          [await buildLanguageRow(locale)],
        ),
      );
    },
  },
];
