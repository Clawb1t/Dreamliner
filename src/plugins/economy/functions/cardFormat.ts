import type { Translator } from "../../../i18n/index.js";
import { CARD_TYPE_META, RARITY_META, type CardType, type PlaneTypeRow, type Rarity } from "./catalog.js";
import { formatAmount, GLOBAL_CURRENCY_DENOMINATOR } from "./format.js";

/** Plain "$10.00", no emoji/backticks: for places that can't render markdown, like button labels. */
export function formatPlainAmount(amount: number): string {
  return `${GLOBAL_CURRENCY_DENOMINATOR}${formatAmount(amount)}`;
}

/** Translated rarity label, no emoji, e.g. "Legendary". */
export function rarityBadge(rarity: string, t: Translator): string {
  const meta = RARITY_META[rarity as Rarity];
  if (!meta) return rarity;
  return t(`economy.rarity.${rarity}`, meta.label);
}

export function rarityColor(rarity: string): number {
  return RARITY_META[rarity as Rarity]?.color ?? 0x5865f2;
}

/** Translated card type label, e.g. "Airline". */
export function cardTypeBadge(cardType: string, t: Translator): string {
  const meta = CARD_TYPE_META[cardType as CardType];
  if (!meta) return cardType;
  return t(`economy.cardType.${cardType}`, meta.label);
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
export function statsFields(card: PlaneTypeRow, t: Translator) {
  if (card.cardType === "airline") {
    return [
      { name: t("economy.stat.reputation", "Reputation"), value: `${card.reputation}/100`, inline: true },
      { name: t("economy.stat.fleetSize", "Fleet Size"), value: formatCount(card.fleetSize), inline: true },
      { name: t("economy.stat.destinations", "Destinations"), value: formatCount(card.destinations), inline: true },
      { name: t("economy.stat.safety", "Safety"), value: `${card.safety}/100`, inline: true },
    ];
  }
  return [
    { name: t("economy.stat.speed", "Speed"), value: `${card.speed}/100`, inline: true },
    { name: t("economy.stat.agility", "Agility"), value: `${card.agility}/100`, inline: true },
    { name: t("economy.stat.safety", "Safety"), value: `${card.safety}/100`, inline: true },
    { name: t("economy.stat.passengers", "Passengers"), value: formatCount(card.passengerCount), inline: true },
  ];
}
