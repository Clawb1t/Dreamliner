import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type AttachmentBuilder, type EmbedBuilder } from "discord.js";
import { baseEmbed } from "../../../core/embeds.js";
import { formatPlainAmount } from "./cardFormat.js";
import { PLANE_INVENTORY_PREFIX, PLANE_LABEL_PREFIX, PLANE_SELL_PREFIX, PLANE_STATS_PREFIX } from "./customIds.js";
import { planeImageAttachment } from "./images.js";
import { rollSellPrice } from "./value.js";
import type { PlaneTypeRow } from "./catalog.js";
import type { OwnedCard } from "./inventory.js";

/** Sell price is rolled once here and embedded in the button's customId, so the amount a member
 *  sees is exactly the amount they get if they click it. */
function sellButton(plane: PlaneTypeRow, ownerId: string): { button: ButtonBuilder; price: number } {
  const price = rollSellPrice(plane.rarity);
  const priceCents = Math.round(price * 100);
  const button = new ButtonBuilder()
    .setCustomId(`${PLANE_SELL_PREFIX}${plane.id}:${ownerId}:${priceCents}`)
    .setLabel(`Sell for ${formatPlainAmount(price)}`)
    .setStyle(ButtonStyle.Primary);
  return { button, price };
}

/**
 * Card reveal used both by `/planes card view` and the pack-opening reveal: a disabled blurple
 * button showing the plane's name, a "View Stats" button next to it, and the art (if the file
 * exists) as a plain message attachment, no embed. Pass `ownerId` (the pack-opening reveal does)
 * to add a "Sell for $X" button — `/planes card view` leaves it out since a browsed card isn't
 * necessarily owned by the viewer.
 */
export function buildCardReveal(plane: PlaneTypeRow, ownerId?: string): { row: ActionRowBuilder<ButtonBuilder>; files: AttachmentBuilder[] } {
  const buttons = [
    new ButtonBuilder().setCustomId(`${PLANE_LABEL_PREFIX}${plane.id}`).setLabel(plane.name).setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId(`${PLANE_STATS_PREFIX}${plane.id}`).setLabel("View Stats").setStyle(ButtonStyle.Secondary),
  ];
  if (ownerId) buttons.push(sellButton(plane, ownerId).button);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
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
  // Only the owner browsing their own hangar can sell from here — someone else's hangar shows
  // the same four buttons it always has, no sell option.
  const isOwnHangar = opts.viewerId === opts.targetUserId;

  const buttons = [
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
  ];
  if (isOwnHangar) buttons.push(sellButton(plane, opts.targetUserId).button);
  buttons.push(
    new ButtonBuilder()
      .setCustomId(`${PLANE_INVENTORY_PREFIX}${idBase}:n:${nextIndex}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canScroll),
  );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
  const art = planeImageAttachment(plane.imageKey);
  return { embed, row, files: art ? [art.attachment] : [] };
}

/** Multiple cards revealed at once (a pack opening): one row + one image per card, stacked. Every
 *  card was just added to `ownerId`'s hangar, so each row gets a Sell button too. */
export function buildCardRevealBatch(planes: PlaneTypeRow[], ownerId: string): { rows: ActionRowBuilder<ButtonBuilder>[]; files: AttachmentBuilder[] } {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const files: AttachmentBuilder[] = [];
  for (const plane of planes) {
    const reveal = buildCardReveal(plane, ownerId);
    rows.push(reveal.row);
    files.push(...reveal.files);
  }
  return { rows, files };
}
