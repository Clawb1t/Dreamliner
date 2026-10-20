import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { userCosmeticsEquipped } from "../../db/schema.js";
import { cosmeticConfigOf, cosmeticStyleOf, getProduct, listProducts, ownedProductIds, type StoreProduct } from "../store/products.js";
import { getCachedStyle, invalidateUserCosmetics, setCachedStyle } from "./cache.js";
import { COSMETIC_SLOTS, isCosmeticSlot, type CosmeticSlot, type CosmeticStyle } from "./types.js";

/** Which cosmetic a member wears in each slot, and the resolved styles the cards and site draw. */

export type EquippedMap = Record<CosmeticSlot, string | null>;

function emptyEquipped(): EquippedMap {
  return Object.fromEntries(COSMETIC_SLOTS.map((slot) => [slot, null])) as EquippedMap;
}

/** Cosmetic products this member owns (bought on their own or through a bundle), archived ones included. */
export function listOwnedCosmetics(userId: string): StoreProduct[] {
  const owned = ownedProductIds(userId);
  return listProducts({ includeInactive: true }).filter((product) => product.type === "cosmetic" && owned.has(product.id));
}

/** The product id worn in each slot (null for an empty slot). */
export function getEquippedCosmetics(userId: string): EquippedMap {
  const equipped = emptyEquipped();
  const rows = getDb().select().from(userCosmeticsEquipped).where(eq(userCosmeticsEquipped.userId, userId)).all();
  for (const row of rows) {
    if (isCosmeticSlot(row.slot)) equipped[row.slot] = row.productId;
  }
  return equipped;
}

export type EquipResult = { ok: true; equipped: EquippedMap } | { ok: false; status: number; error: string };

/** Wears `productId` in `slot`, or empties the slot with null. The member must own it. */
export function equipCosmetic(userId: string, slot: unknown, productId: string | null, now: Date = new Date()): EquipResult {
  if (!isCosmeticSlot(slot)) return { ok: false, status: 400, error: "That isn't a cosmetic slot." };
  if (productId === null) {
    getDb()
      .delete(userCosmeticsEquipped)
      .where(and(eq(userCosmeticsEquipped.userId, userId), eq(userCosmeticsEquipped.slot, slot)))
      .run();
    invalidateUserCosmetics(userId);
    return { ok: true, equipped: getEquippedCosmetics(userId) };
  }
  const product = getProduct(productId);
  const config = product ? cosmeticConfigOf(product) : null;
  if (!product || !config || !ownedProductIds(userId).has(product.id)) {
    return { ok: false, status: 403, error: "You don't own that cosmetic." };
  }
  if (config.slot !== slot) return { ok: false, status: 400, error: `${product.name} goes in the ${config.slot} slot.` };
  getDb()
    .insert(userCosmeticsEquipped)
    .values({ userId, slot, productId, equippedAt: now })
    .onConflictDoUpdate({ target: [userCosmeticsEquipped.userId, userCosmeticsEquipped.slot], set: { productId, equippedAt: now } })
    .run();
  invalidateUserCosmetics(userId);
  return { ok: true, equipped: getEquippedCosmetics(userId) };
}

/** Builds resolved styles from equip rows, skipping items that no longer exist or don't fit. */
function resolveRows(rows: Array<{ userId: string; slot: string; productId: string }>): Map<string, CosmeticStyle> {
  const byUser = new Map<string, CosmeticStyle>();
  const products = new Map(listProducts({ includeInactive: true }).map((product) => [product.id, product]));
  for (const row of rows) {
    const product = products.get(row.productId);
    const config = product ? cosmeticConfigOf(product) : null;
    if (!product || !config || config.slot !== row.slot) continue;
    const style = byUser.get(row.userId) ?? {};
    Object.assign(style, cosmeticStyleOf(product));
    byUser.set(row.userId, style);
  }
  return byUser;
}

/**
 * Resolved styles for many users at once (one query for everyone not cached), cached about a
 * minute. Users with nothing equipped map to an empty object.
 */
export function getEquippedCosmeticsForUsers(userIds: string[]): Map<string, CosmeticStyle> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const result = new Map<string, CosmeticStyle>();
  const missing: string[] = [];
  for (const userId of unique) {
    const cached = getCachedStyle(userId);
    if (cached) result.set(userId, cached);
    else missing.push(userId);
  }
  for (let i = 0; i < missing.length; i += 500) {
    const chunk = missing.slice(i, i + 500);
    const rows = getDb()
      .select({ userId: userCosmeticsEquipped.userId, slot: userCosmeticsEquipped.slot, productId: userCosmeticsEquipped.productId })
      .from(userCosmeticsEquipped)
      .where(inArray(userCosmeticsEquipped.userId, chunk))
      .all();
    const resolved = resolveRows(rows);
    for (const userId of chunk) {
      const style = resolved.get(userId) ?? {};
      setCachedStyle(userId, style);
      result.set(userId, style);
    }
  }
  return result;
}

/** One user's resolved style (empty object when nothing is equipped). */
export function getEquippedStyle(userId: string): CosmeticStyle {
  return getEquippedCosmeticsForUsers([userId]).get(userId) ?? {};
}

/** Erase: forgets what this member wears (ownership stays, as purchase records). */
export function deleteEquippedCosmetics(userId: string): number {
  const removed = getDb().delete(userCosmeticsEquipped).where(eq(userCosmeticsEquipped.userId, userId)).returning().all().length;
  invalidateUserCosmetics(userId);
  return removed;
}
