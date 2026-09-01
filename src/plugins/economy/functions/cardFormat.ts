import { CARD_TYPE_META, RARITY_META, type CardType, type PlaneTypeRow, type Rarity } from "./catalog.js";
import { formatAmount, GLOBAL_CURRENCY_DENOMINATOR } from "./format.js";

/** Plain "$10.00", no emoji/backticks: for places that can't render markdown, like button labels. */
export function formatPlainAmount(amount: number): string {
  return `${GLOBAL_CURRENCY_DENOMINATOR}${formatAmount(amount)}`;
}

/** Plain rarity label, no emoji, e.g. "Legendary". */
export function rarityBadge(rarity: string): string {
  return RARITY_META[rarity as Rarity]?.label ?? rarity;
}

export function rarityColor(rarity: string): number {
  return RARITY_META[rarity as Rarity]?.color ?? 0x5865f2;
}

/** Plain card type label, e.g. "Airline". */
export function cardTypeBadge(cardType: string): string {
  return CARD_TYPE_META[cardType as CardType]?.label ?? cardType;
}

export function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

/** One-line summary used in inventory/catalog lists, e.g. "**Boeing 737** `boeing-737` · x3". */
export function planeLine(plane: PlaneTypeRow, quantity?: number): string {
  const qty = quantity !== undefined ? ` · \`x${quantity}\`` : "";
  return `**${plane.name}** \`${plane.key}\`${qty}`;
}

/** Stats fields for a card's embed, chosen by its card type: Speed/Agility/Safety/Passengers for a
 *  plane, Reputation/Fleet Size/Destinations/Safety for an airline. Safety is shared by both. */
export function statsFields(card: PlaneTypeRow) {
  if (card.cardType === "airline") {
    return [
      { name: "Reputation", value: `${card.reputation}/100`, inline: true },
      { name: "Fleet Size", value: formatCount(card.fleetSize), inline: true },
      { name: "Destinations", value: formatCount(card.destinations), inline: true },
      { name: "Safety", value: `${card.safety}/100`, inline: true },
    ];
  }
  return [
    { name: "Speed", value: `${card.speed}/100`, inline: true },
    { name: "Agility", value: `${card.agility}/100`, inline: true },
    { name: "Safety", value: `${card.safety}/100`, inline: true },
    { name: "Passengers", value: formatCount(card.passengerCount), inline: true },
  ];
}
