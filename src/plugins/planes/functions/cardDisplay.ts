import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type AttachmentBuilder, type EmbedBuilder } from "discord.js";
import { baseEmbed } from "../../../core/embeds.js";
import { PLANE_INVENTORY_PREFIX, PLANE_LABEL_PREFIX, PLANE_STATS_PREFIX } from "./customIds.js";
import { planeImageAttachment } from "./images.js";
import type { PlaneTypeRow } from "./catalog.js";
import type { OwnedCard } from "./inventory.js";

/**
 * Card reveal used both by `/planes card view` and the pack-opening reveal: a disabled blurple
 * button showing the plane's name, a "View Stats" button next to it, and the art (if the file
 * exists) as a plain message attachment, no embed.
 */
export function buildCardReveal(plane: PlaneTypeRow): { row: ActionRowBuilder<ButtonBuilder>; files: AttachmentBuilder[] } {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PLANE_LABEL_PREFIX}${plane.id}`).setLabel(plane.name).setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId(`${PLANE_STATS_PREFIX}${plane.id}`).setLabel("View Stats").setStyle(ButtonStyle.Secondary),
  );
  const art = planeImageAttachment(plane.imageKey);
  return { row, files: art ? [art.attachment] : [] };
}

/**
 * One page of a paged inventory browser: an embed showing the plane and how many the viewer
 * owns, the same image attachment + View Stats button as a card reveal, plus Previous/Next
 * buttons that wrap around the owner's sorted inventory.
 */
export function buildInventoryPage(
  card: OwnedCard,
  opts: { index: number; total: number; viewerId: string; targetUserId: string },
): { embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder>; files: AttachmentBuilder[] } {
  const { plane, quantity } = card;
  const embed = baseEmbed()
    .setDescription(`**${plane.name}**\n-# You own **x${quantity}**`)
    .setFooter({ text: `Card ${opts.index + 1} of ${opts.total}` });

  const canScroll = opts.total > 1;
  const prevIndex = (opts.index - 1 + opts.total) % opts.total;
  const nextIndex = (opts.index + 1) % opts.total;
  const idBase = `${opts.viewerId}:${opts.targetUserId}`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    // "p:"/"n:" markers keep these two IDs distinct even when total === 1, where prevIndex and
    // nextIndex both wrap around to the same value — Discord rejects a message with two
    // components sharing a custom_id even if one (or both) is disabled.
    new ButtonBuilder()
      .setCustomId(`${PLANE_INVENTORY_PREFIX}${idBase}:p:${prevIndex}`)
      .setLabel("Back")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canScroll),
    new ButtonBuilder().setCustomId(`${PLANE_LABEL_PREFIX}${plane.id}`).setLabel(plane.name).setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId(`${PLANE_STATS_PREFIX}${plane.id}`).setLabel("View Stats").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${PLANE_INVENTORY_PREFIX}${idBase}:n:${nextIndex}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canScroll),
  );
  const art = planeImageAttachment(plane.imageKey);
  return { embed, row, files: art ? [art.attachment] : [] };
}

/** Multiple cards revealed at once (a pack opening): one row + one image per card, stacked. */
export function buildCardRevealBatch(planes: PlaneTypeRow[]): { rows: ActionRowBuilder<ButtonBuilder>[]; files: AttachmentBuilder[] } {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const files: AttachmentBuilder[] = [];
  for (const plane of planes) {
    const reveal = buildCardReveal(plane);
    rows.push(reveal.row);
    files.push(...reveal.files);
  }
  return { rows, files };
}
