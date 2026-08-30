import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
} from "discord.js";
import { configManager } from "../../../config/manager.js";
import { resolveEmojiForContent } from "../../../core/emoji.js";
import { downloadNekoImage, nekoRefToUrl } from "./nekosBest.js";
import { formatNekoContent, parseNekoCredit } from "./format.js";
import { listSavedNekos, saveNeko, unsaveNeko, type SavedNeko } from "./store.js";

export const ANIME_SAVE_PREFIX = "anime:save:";
export const ANIME_SAVED_NAV_PREFIX = "anime:savednav:";

export function buildNekoSaveRow(ref: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ANIME_SAVE_PREFIX}${ref}`)
      .setLabel("Save")
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildSavedNavRow(index: number, total: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ANIME_SAVED_NAV_PREFIX}left:${index}`)
      .setLabel("Left")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index <= 0),
    new ButtonBuilder()
      .setCustomId(`${ANIME_SAVED_NAV_PREFIX}unsave:${index}`)
      .setLabel("Unsave")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${ANIME_SAVED_NAV_PREFIX}right:${index}`)
      .setLabel("Right")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index >= total - 1),
  );
}

async function buildSavedViewPayload(
  neko: SavedNeko,
  index: number,
  total: number,
  successEmoji: string,
) {
  const image = await downloadNekoImage(neko.imageUrl).catch(() => null);
  return {
    content: `${formatNekoContent(neko.artistName, neko.artistHref, successEmoji)}\n-# Saved neko ${index + 1}/${total}`,
    files: image ? [new AttachmentBuilder(image.buffer, { name: image.filename })] : [],
    attachments: [],
    components: [buildSavedNavRow(index, total)],
  };
}

/** "Save" button on a fresh `/anime neko` reply — saves it to the clicker's own collection. */
export async function handleAnimeSaveButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(ANIME_SAVE_PREFIX)) return false;

  const ref = interaction.customId.slice(ANIME_SAVE_PREFIX.length);
  const { artistName, artistHref } = parseNekoCredit(interaction.message.content);
  const result = await saveNeko(interaction.user.id, {
    imageUrl: nekoRefToUrl(ref),
    artistName,
    artistHref,
  });

  await interaction
    .reply({
      content: result.ok ? "Saved! Use `/anime saved` to browse your nekos." : result.error,
      flags: MessageFlags.Ephemeral,
    })
    .catch(() => null);
  return true;
}

/** Left/Unsave/Right on an `/anime saved` reply — always re-reads the clicker's list fresh. */
export async function handleAnimeSavedNavButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(ANIME_SAVED_NAV_PREFIX)) return false;

  const rest = interaction.customId.slice(ANIME_SAVED_NAV_PREFIX.length);
  const [action, indexRaw] = rest.split(":");
  const currentIndex = Number(indexRaw);
  if (!Number.isInteger(currentIndex) || currentIndex < 0) return true;

  if (action === "unsave") {
    const before = await listSavedNekos(interaction.user.id);
    const target = before[currentIndex];
    if (target) await unsaveNeko(interaction.user.id, target.id);
  }

  const saved = await listSavedNekos(interaction.user.id);
  if (saved.length === 0) {
    await interaction
      .update({ content: "You have no saved nekos left.", files: [], attachments: [], components: [] })
      .catch(() => null);
    return true;
  }

  let nextIndex = currentIndex;
  if (action === "left") nextIndex = currentIndex - 1;
  else if (action === "right") nextIndex = currentIndex + 1;
  nextIndex = Math.min(Math.max(nextIndex, 0), saved.length - 1);

  // `interaction.guildId` can only be missing in a DM, which this feature isn't used from in
  // practice — falls back to a plain checkmark rather than requiring guild context here.
  const guildConfig = interaction.guildId ? await configManager.getEffectiveConfig(interaction.guildId) : null;
  const successEmoji = guildConfig
    ? resolveEmojiForContent(guildConfig.emojis.success, interaction.client)
    : "✅";
  const payload = await buildSavedViewPayload(saved[nextIndex]!, nextIndex, saved.length, successEmoji);
  await interaction.update(payload).catch(() => null);
  return true;
}
