import { getDb } from "../../../db/client.js";
import { planeCardPackOpenings } from "../../../db/schema.js";
import { ensureGlobalAccount, spendGlobal, InsufficientFundsError } from "../../economy/functions/money.js";
import { RARITY_META, RARITY_ORDER, listPlaneTypes, type PlaneTypeRow, type Rarity } from "./catalog.js";
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

/** Picks one enabled plane, weighted by rarity, then uniformly among planes of that rarity. */
function drawPlane(catalog: PlaneTypeRow[]): PlaneTypeRow {
  const byRarity = new Map<Rarity, PlaneTypeRow[]>();
  for (const plane of catalog) {
    const rarity = plane.rarity as Rarity;
    const bucket = byRarity.get(rarity);
    if (bucket) bucket.push(plane);
    else byRarity.set(rarity, [plane]);
  }

  const available = RARITY_ORDER.filter((r) => (byRarity.get(r)?.length ?? 0) > 0);
  const totalWeight = available.reduce((sum, r) => sum + RARITY_META[r].weight, 0);
  let roll = Math.random() * totalWeight;
  let chosen: Rarity = available[available.length - 1];
  for (const rarity of available) {
    roll -= RARITY_META[rarity].weight;
    if (roll <= 0) {
      chosen = rarity;
      break;
    }
  }

  const pool = byRarity.get(chosen)!;
  return pool[Math.floor(Math.random() * pool.length)];
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
