import type { StringSelectMenuInteraction } from "discord.js";
import { APP_EMOJI } from "../../../core/appEmojis.js";
import { resultEdit } from "../../../core/responses.js";
import { listEnabledLanguages, preloadCatalog, setUserLocale, translateSync } from "../../../i18n/index.js";
import { LANGUAGE_SELECT_PREFIX } from "../constants.js";

export async function handleLanguageSelectInteraction(interaction: StringSelectMenuInteraction): Promise<boolean> {
  if (interaction.customId !== LANGUAGE_SELECT_PREFIX) return false;

  const chosen = interaction.values[0]!;
  const languages = await listEnabledLanguages();
  const language = languages.find((lang) => lang.code === chosen);
  if (!language) {
    await interaction
      .update(resultEdit("Language", "That language isn't available anymore. Run `/language` again to pick another.", { tone: "error" }))
      .catch(() => null);
    return true;
  }

  const result = await setUserLocale(interaction.user.id, chosen);
  if (!result.ok) {
    await interaction.update(resultEdit("Language", result.error, { tone: "error" })).catch(() => null);
    return true;
  }

  const catalog = await preloadCatalog(chosen);
  const message = translateSync(
    chosen,
    "language.confirm",
    `Dreamliner will now reply to you in **${language.name}**.`,
    catalog,
  );
  await interaction
    .update(resultEdit("Language", message, { emoji: language.flag || APP_EMOJI.globe }))
    .catch(() => null);
  return true;
}
