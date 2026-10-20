import { equipCosmetic, getEquippedCosmetics, listOwnedCosmetics, type EquippedMap } from "../core/cosmetics/equip.js";
import { toProductPayload, type StoreProductPayload } from "../core/store/products.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("store");

/** The website's account Cosmetics panel: what a member owns and wears. */

export type WebCosmetics = { ok: true; owned: StoreProductPayload[]; equipped: EquippedMap };

export function getWebCosmetics(userId: string): WebCosmetics {
  const now = new Date();
  return {
    ok: true,
    owned: listOwnedCosmetics(userId).map((product) => toProductPayload(product, now)),
    equipped: getEquippedCosmetics(userId),
  };
}

export type WebEquipResult = { status: number; body: { ok: true; equipped: EquippedMap } | { ok: false; error: string } };

export function equipWebCosmetic(userId: string, body: Record<string, unknown>): WebEquipResult {
  const productId = body.productId;
  if (productId !== null && (typeof productId !== "string" || !productId.trim())) {
    return { status: 400, body: { ok: false, error: "productId must be a product id or null." } };
  }
  const result = equipCosmetic(userId, body.slot, productId === null ? null : productId.trim());
  if (!result.ok) return { status: result.status, body: { ok: false, error: result.error } };
  log.debug(`[store] ${userId} equipped ${productId ?? "nothing"} in ${String(body.slot)}.`);
  return { status: 200, body: { ok: true, equipped: result.equipped } };
}
