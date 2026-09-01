import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { planeCardInventory } from "../../../db/schema.js";
import { creditGlobal } from "./money.js";
import { getPlaneTypesByIds, RARITY_ORDER, type PlaneTypeRow, type Rarity } from "./catalog.js";

function now() {
  return new Date();
}

export type InventoryEntry = { planeTypeId: number; quantity: number; firstObtainedAt: Date };

export function getInventoryEntry(userId: string, planeTypeId: number): InventoryEntry | null {
  return (
    getDb()
      .select()
      .from(planeCardInventory)
      .where(and(eq(planeCardInventory.userId, userId), eq(planeCardInventory.planeTypeId, planeTypeId)))
      .get() ?? null
  );
}

export function getOwnedPlaneTypeIds(userId: string): Set<number> {
  const rows = getDb()
    .select({ planeTypeId: planeCardInventory.planeTypeId })
    .from(planeCardInventory)
    .where(eq(planeCardInventory.userId, userId))
    .all();
  return new Set(rows.map((r) => r.planeTypeId));
}

export type OwnedCard = { plane: PlaneTypeRow; quantity: number; firstObtainedAt: Date };

export function getInventory(userId: string): OwnedCard[] {
  const rows = getDb().select().from(planeCardInventory).where(eq(planeCardInventory.userId, userId)).all();
  const planes = getPlaneTypesByIds(rows.map((r) => r.planeTypeId));
  const byId = new Map(planes.map((p) => [p.id, p]));
  return rows
    .map((r) => {
      const plane = byId.get(r.planeTypeId);
      return plane ? { plane, quantity: r.quantity, firstObtainedAt: r.firstObtainedAt } : null;
    })
    .filter((r): r is OwnedCard => r !== null);
}

/** A user's inventory, rarest-first then alphabetical, for the paged inventory browser. */
export function getSortedInventory(userId: string): OwnedCard[] {
  return getInventory(userId).sort(
    (a, b) => RARITY_ORDER.indexOf(b.plane.rarity as Rarity) - RARITY_ORDER.indexOf(a.plane.rarity as Rarity) || a.plane.name.localeCompare(b.plane.name),
  );
}

/** Adds `quantity` of a plane type to a user's inventory, upserting the row. */
export function addToInventory(userId: string, planeTypeId: number, quantity = 1): void {
  const db = getDb();
  const existing = getInventoryEntry(userId, planeTypeId);
  const timestamp = now();
  if (existing) {
    db.update(planeCardInventory)
      .set({ quantity: existing.quantity + quantity, updatedAt: timestamp })
      .where(and(eq(planeCardInventory.userId, userId), eq(planeCardInventory.planeTypeId, planeTypeId)))
      .run();
    return;
  }
  db.insert(planeCardInventory)
    .values({ userId, planeTypeId, quantity, firstObtainedAt: timestamp, updatedAt: timestamp })
    .run();
}

export class InventoryError extends Error {
  constructor(message = "You don't own enough of that card.") {
    super(message);
    this.name = "InventoryError";
  }
}

/** Removes `quantity` of a plane type from a user's inventory, throwing if they don't own enough. */
export function removeFromInventory(userId: string, planeTypeId: number, quantity: number): void {
  const db = getDb();
  const existing = getInventoryEntry(userId, planeTypeId);
  if (!existing || existing.quantity < quantity) throw new InventoryError();
  const remaining = existing.quantity - quantity;
  if (remaining <= 0) {
    db.delete(planeCardInventory)
      .where(and(eq(planeCardInventory.userId, userId), eq(planeCardInventory.planeTypeId, planeTypeId)))
      .run();
    return;
  }
  db.update(planeCardInventory)
    .set({ quantity: remaining, updatedAt: now() })
    .where(and(eq(planeCardInventory.userId, userId), eq(planeCardInventory.planeTypeId, planeTypeId)))
    .run();
}

/** Gives exactly `quantity` of a card from one user to another, atomically. Throws InventoryError
 *  if the giver doesn't own enough. */
export function giveCard(fromUserId: string, toUserId: string, planeTypeId: number, quantity = 1): void {
  getDb().transaction(() => {
    removeFromInventory(fromUserId, planeTypeId, quantity);
    addToInventory(toUserId, planeTypeId, quantity);
  });
}

/** Sells one copy of a card for `amount` global coins, atomically — removes it from the seller's
 *  inventory and credits the coins. Returns the new global balance. Throws InventoryError if the
 *  seller no longer owns a copy. */
export function sellCard(userId: string, planeTypeId: number, amount: number): number {
  return getDb().transaction(() => {
    removeFromInventory(userId, planeTypeId, 1);
    return creditGlobal(userId, amount);
  });
}
