import { round2 } from "../../economy/functions/money.js";
import { RARITY_ORDER, type Rarity } from "./catalog.js";

/**
 * Base sell value per rarity, deliberately kept below what a $10 pack needs to "pay for itself"
 * on average: at the pack's draw weights (common 55%, uncommon 27%, rare 12%, epic 5%,
 * legendary 1%), the expected sell value of one drawn card is ~$7.25 — buying a pack just to
 * sell what comes out of it is a losing trade on average, so grinding packs can't inflate the
 * global economy. Legendary's $100 base doubles as the hard ceiling every rolled price is
 * clamped to below.
 */
export const RARITY_SELL_VALUE: Record<Rarity, number> = {
  common: 2,
  uncommon: 5,
  rare: 15,
  epic: 40,
  legendary: 100,
};

/** Randomisation applied on top of a rarity's base sell value: ±20%. */
const SELL_VARIANCE = 0.2;

/** No card of any rarity can ever sell for more than this — legendary's own base value. */
const MAX_SELL_VALUE = RARITY_SELL_VALUE.legendary;

/** A random sell price for a card of this rarity: its base value ±20%, clamped to `$0`–`$100`. */
export function rollSellPrice(rarity: string): number {
  const base = RARITY_SELL_VALUE[rarity as Rarity] ?? RARITY_SELL_VALUE[RARITY_ORDER[0]];
  const variance = 1 + (Math.random() * 2 - 1) * SELL_VARIANCE;
  return round2(Math.min(MAX_SELL_VALUE, Math.max(0, base * variance)));
}
