import { ComponentType, type APIActionRowComponent, type APIComponentInMessageActionRow, type ButtonInteraction } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { BIRTHDAY_EMOJI, BIRTHDAY_TADA_EMOJI } from "../../../config/schemas/birthdays.js";
import { guildResultOptions, resultReply } from "../../../core/responses.js";
import { translatorFor } from "../../../i18n/index.js";
import { BIRTHDAY_WISH_CUSTOM_ID, wishButtonLabel } from "./celebrate.js";
import { loadBirthdaysConfig } from "./config.js";
import { addWish, celebrationByMessage, countWishes } from "./store.js";

/** "Wish happy birthday" on an announcement: one wish per member, tallied on the button. */
export async function handleBirthdayWishButton(interaction: ButtonInteraction): Promise<boolean> {
  if (interaction.customId !== BIRTHDAY_WISH_CUSTOM_ID) return false;
  const { t } = await translatorFor(interaction.user.id);
  if (!interaction.inGuild() || !interaction.guildId) return false;

  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  const options = guildResultOptions(interaction.client, guildConfig);
  const celebration = celebrationByMessage(interaction.message.id);
  if (!celebration) {
    await interaction.reply(
      resultReply(
        t("birthdays.wishGoneTitle", "Birthday's over"),
        t("birthdays.wishGoneBody", "This birthday isn't taking wishes anymore."),
        true,
        options,
      ),
    );
    return true;
  }

  if (celebration.userId === interaction.user.id) {
    await interaction.reply(
      resultReply(
        t("birthdays.wishSelfTitle", "Happy birthday! {emoji}", { emoji: BIRTHDAY_EMOJI }),
        t("birthdays.wishSelfBody", "This one's for everyone else to press. Enjoy your day!"),
        true,
        { ...options, tone: "success" },
      ),
    );
    return true;
  }

  if (!addWish(interaction.message.id, interaction.user.id)) {
    await interaction.reply(
      resultReply(
        t("birthdays.wishAgainTitle", "Already wished"),
        t("birthdays.wishAgainBody", "You've already wished <@{user}> a happy birthday.", { user: celebration.userId }),
        true,
        options,
      ),
    );
    return true;
  }

  await interaction.reply(
    resultReply(
      t("birthdays.wishSentTitle", "Wish sent {emoji}", { emoji: BIRTHDAY_TADA_EMOJI }),
      t("birthdays.wishSentBody", "You wished <@{user}> a happy birthday.", { user: celebration.userId }),
      true,
      { ...options, tone: "success" },
    ),
  );

  // Refresh the tally on the button, leaving the link buttons as they are.
  const announcement = loadBirthdaysConfig(guildConfig).announcement;
  const wishes = countWishes(interaction.message.id);
  const label = wishButtonLabel(announcement, wishes).slice(0, 80);
  const rows = interaction.message.components
    .map((row) => row.toJSON())
    .filter((row): row is APIActionRowComponent<APIComponentInMessageActionRow> => row.type === ComponentType.ActionRow)
    .map((row) => ({
      ...row,
      components: row.components.map((component) =>
        "custom_id" in component && component.custom_id === BIRTHDAY_WISH_CUSTOM_ID ? { ...component, label } : component,
      ),
    }));
  await interaction.message.edit({ components: rows }).catch(() => null);
  return true;
}
