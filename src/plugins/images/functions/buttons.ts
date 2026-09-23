import type { ButtonInteraction, GuildMember } from "discord.js";
import { configManager } from "../../../config/manager.js";
import { IMAGE_SOURCES, type ImageSource } from "../../../config/schemas/images.js";
import { hasPermission } from "../../../core/permissionRoles.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { guildResultOptions, resultReply } from "../../../core/responses.js";
import { getLogger } from "../../../core/logger.js";
import { translatorFor } from "../../../i18n/index.js";
import { fetchImage, IMAGE_SOURCE_LABELS } from "./sources.js";
import { anotherImageRow, IMAGE_ANOTHER_PREFIX, imagePayload } from "./render.js";

const log = getLogger("images");

function isSource(value: string): value is ImageSource {
  return (IMAGE_SOURCES as readonly string[]).includes(value);
}

/** "Another <type>" on an /image reply: swaps the image in place for a fresh one of the same type. */
export async function handleImageAnotherButton(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(IMAGE_ANOTHER_PREFIX)) return false;
  const [source, ownerId] = interaction.customId.slice(IMAGE_ANOTHER_PREFIX.length).split(":");
  if (!source || !isSource(source) || !interaction.inGuild() || !interaction.guild) return false;

  const { t } = await translatorFor(interaction.user.id);
  const guildConfig = await configManager.getEffectiveConfig(interaction.guildId);
  const options = guildResultOptions(interaction.client, guildConfig, { tone: "error" });

  if (interaction.user.id !== ownerId) {
    await interaction.reply(
      resultReply(
        t("images.notYoursTitle", "Not your image"),
        t("images.notYoursBody", "Only the person who ran this can swap the image. Run /image to get your own."),
        true,
        options,
      ),
    );
    return true;
  }

  const member = interaction.member as GuildMember;
  if (
    !pluginEnabled(guildConfig, "images") ||
    !(await hasPermission(interaction.guildId, "images", "can_use", member, guildConfig))
  ) {
    await interaction.reply(
      resultReply(
        t("common.permissionDeniedTitle", "Permission denied"),
        t("common.noPermission", "You do not have permission to use this command."),
        true,
        options,
      ),
    );
    return true;
  }

  await interaction.deferUpdate();
  try {
    const image = await fetchImage(source);
    await interaction.editReply(
      imagePayload(source, IMAGE_SOURCE_LABELS[source], image, false, anotherImageRow(source, ownerId)),
    );
  } catch (err) {
    log.warn(`Image reroll failed (${source}):`, err);
    await interaction.followUp(
      resultReply(
        t("images.fetchFailedTitle", "Couldn't fetch an image"),
        t("images.fetchFailed", "Couldn't fetch an image right now. Try again in a moment."),
        true,
        options,
      ),
    );
  }
  return true;
}
