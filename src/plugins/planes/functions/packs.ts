import { getDb } from "../../../db/client.js";
import { planeCardPackOpenings } from "../../../db/schema.js";
import { ensureGlobalAccount, spendGlobal, InsufficientFundsError } from "../../economy/functions/money.js";
import { RARITY_META, listPlaneTypes, type PlaneTypeRow, type Rarity } from "./catalog.js";
import { addToInventory } from "./inventory.js";

export class PackError extends Error {
  constructor(
    message: string,
    public code: "empty_catalog" | "insufficient" | "invalid" = "invalid",
  ) {
    super(message);
    this.name = "PackError";
  }
}

/**
 * Picks one enabled card, weighted per-card by its rarity (not per-rarity-tier-then-uniform).
 * This keeps each individual card's odds anchored to its rarity's base weight instead of a
 * thin tier's total probability mass getting concentrated onto just a couple of cards: a
 * rarity's overall share of pulls scales with how many live cards actually exist in it right
 * now, so a legendary tier with 2 cards pulls far less often overall than one with 20, and a
 * newly-added card in a sparse tier doesn't instantly become common.
 */
function drawPlane(catalog: PlaneTypeRow[]): PlaneTypeRow {
  const totalWeight = catalog.reduce((sum, plane) => sum + RARITY_META[plane.rarity as Rarity].weight, 0);
  let roll = Math.random() * totalWeight;
  for (const plane of catalog) {
    roll -= RARITY_META[plane.rarity as Rarity].weight;
    if (roll <= 0) return plane;
  }
  return catalog[catalog.length - 1];
}

export type PackResult = { cards: PlaneTypeRow[]; cost: number; balance: number };

/** Spends global coins and draws `packSize` random enabled planes, adding them to the user's inventory. */
export function openPack(userId: string, guildId: string, cost: number, packSize: number): PackResult {
  if (!(cost >= 0)) throw new PackError("Pack price must be non-negative.", "invalid");
  const catalog = listPlaneTypes({ enabledOnly: true });
  if (catalog.length === 0) throw new PackError("No plane cards are available yet. Check back soon.", "empty_catalog");

  const db = getDb();
  try {
    return db.transaction((tx) => {
      const balance = cost > 0 ? spendGlobal(userId, cost) : ensureGlobalAccount(userId).balance;
      const drawn: PlaneTypeRow[] = [];
      for (let i = 0; i < packSize; i++) {
        const plane = drawPlane(catalog);
        drawn.push(plane);
        addToInventory(userId, plane.id, 1);
      }
      tx.insert(planeCardPackOpenings)
        .values({
          userId,
          guildId,
          cost,
          planeTypeIds: JSON.stringify(drawn.map((p) => p.id)),
          createdAt: new Date(),
        })
        .run();
      return { cards: drawn, cost, balance };
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) throw new PackError(err.message, "insufficient");
    throw err;
  }
}
