import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import {
  economyCooldowns,
  economyEffects,
  economyInventory,
  economyItems,
  economyShopListings,
  economyShops,
} from "../../../db/schema.js";
import type { EconomyConfig } from "../../../config/schemas/economy.js";
import { EconomyError, isGuildPaused, mutateMoney } from "./money.js";

function now() {
  return new Date();
}

export type ItemEffect = {
  type?: string;
  multiplier_bps?: number;
  duration_seconds?: number;
  role_id?: string;
};

export function listItems(guildId: string) {
  return getDb().select().from(economyItems).where(eq(economyItems.guildId, guildId)).all();
}

export function getItemByKey(guildId: string, key: string) {
  return getDb()
    .select()
    .from(economyItems)
    .where(and(eq(economyItems.guildId, guildId), eq(economyItems.key, key)))
    .get();
}

export function getItemById(guildId: string, id: number) {
  return getDb()
    .select()
    .from(economyItems)
    .where(and(eq(economyItems.guildId, guildId), eq(economyItems.id, id)))
    .get();
}

export function upsertItem(
  guildId: string,
  input: {
    key: string;
    name: string;
    description?: string;
    emoji?: string;
    itemType?: string;
    stackable?: boolean;
    tradeable?: boolean;
    sellValue?: number;
    currencyKey?: string;
    effectJson?: string;
    lootJson?: string;
    roleId?: string | null;
    petSpeciesKey?: string | null;
  },
) {
  const existing = getItemByKey(guildId, input.key);
  if (existing) {
    getDb()
      .update(economyItems)
      .set({
        name: input.name,
        description: input.description ?? existing.description,
        emoji: input.emoji ?? existing.emoji,
        itemType: input.itemType ?? existing.itemType,
        stackable: input.stackable ?? existing.stackable,
        tradeable: input.tradeable ?? existing.tradeable,
        sellValue: input.sellValue ?? existing.sellValue,
        currencyKey: input.currencyKey ?? existing.currencyKey,
        effectJson: input.effectJson ?? existing.effectJson,
        lootJson: input.lootJson ?? existing.lootJson,
        roleId: input.roleId === undefined ? existing.roleId : input.roleId,
        petSpeciesKey: input.petSpeciesKey === undefined ? existing.petSpeciesKey : input.petSpeciesKey,
      })
      .where(eq(economyItems.id, existing.id))
      .run();
    return getItemById(guildId, existing.id)!;
  }
  getDb()
    .insert(economyItems)
    .values({
      guildId,
      key: input.key,
      name: input.name,
      description: input.description ?? "",
      emoji: input.emoji ?? "📦",
      itemType: input.itemType ?? "collectible",
      stackable: input.stackable ?? true,
      tradeable: input.tradeable ?? true,
      sellValue: input.sellValue ?? 0,
      currencyKey: input.currencyKey ?? "coins",
      effectJson: input.effectJson ?? "{}",
      lootJson: input.lootJson ?? "[]",
      roleId: input.roleId ?? null,
      petSpeciesKey: input.petSpeciesKey ?? null,
      createdAt: now(),
    })
    .run();
  return getItemByKey(guildId, input.key)!;
}

export function deleteItem(guildId: string, id: number) {
  getDb()
    .delete(economyItems)
    .where(and(eq(economyItems.guildId, guildId), eq(economyItems.id, id)))
    .run();
}

export function listShops(guildId: string) {
  return getDb().select().from(economyShops).where(eq(economyShops.guildId, guildId)).all();
}

export function getShopByKey(guildId: string, key: string) {
  return getDb()
    .select()
    .from(economyShops)
    .where(and(eq(economyShops.guildId, guildId), eq(economyShops.key, key)))
    .get();
}

export function upsertShop(
  guildId: string,
  input: { key: string; name: string; description?: string; enabled?: boolean; channelId?: string | null },
) {
  const existing = getShopByKey(guildId, input.key);
  if (existing) {
    getDb()
      .update(economyShops)
      .set({
        name: input.name,
        description: input.description ?? existing.description,
        enabled: input.enabled ?? existing.enabled,
        channelId: input.channelId === undefined ? existing.channelId : input.channelId,
      })
      .where(eq(economyShops.id, existing.id))
      .run();
    return getShopByKey(guildId, input.key)!;
  }
  getDb()
    .insert(economyShops)
    .values({
      guildId,
      key: input.key,
      name: input.name,
      description: input.description ?? "",
      enabled: input.enabled ?? true,
      channelId: input.channelId ?? null,
      createdAt: now(),
    })
    .run();
  return getShopByKey(guildId, input.key)!;
}

export function deleteShop(guildId: string, id: number) {
  getDb()
    .delete(economyShopListings)
    .where(and(eq(economyShopListings.guildId, guildId), eq(economyShopListings.shopId, id)))
    .run();
  getDb()
    .delete(economyShops)
    .where(and(eq(economyShops.guildId, guildId), eq(economyShops.id, id)))
    .run();
}

export function listShopListings(guildId: string, shopId?: number) {
  if (shopId !== undefined) {
    return getDb()
      .select()
      .from(economyShopListings)
      .where(and(eq(economyShopListings.guildId, guildId), eq(economyShopListings.shopId, shopId)))
      .all();
  }
  return getDb().select().from(economyShopListings).where(eq(economyShopListings.guildId, guildId)).all();
}

export function upsertListing(
  guildId: string,
  input: {
    id?: number;
    shopId: number;
    itemId: number;
    price: number;
    currencyKey?: string;
    stock?: number | null;
    maxPerUser?: number | null;
    restockAmount?: number | null;
    restockIntervalSeconds?: number | null;
    enabled?: boolean;
    sortOrder?: number;
  },
) {
  if (input.id) {
    getDb()
      .update(economyShopListings)
      .set({
        shopId: input.shopId,
        itemId: input.itemId,
        price: input.price,
        currencyKey: input.currencyKey ?? "coins",
        stock: input.stock ?? null,
        maxPerUser: input.maxPerUser ?? null,
        restockAmount: input.restockAmount ?? null,
        restockIntervalSeconds: input.restockIntervalSeconds ?? null,
        enabled: input.enabled ?? true,
        sortOrder: input.sortOrder ?? 0,
      })
      .where(and(eq(economyShopListings.guildId, guildId), eq(economyShopListings.id, input.id)))
      .run();
    return getDb()
      .select()
      .from(economyShopListings)
      .where(eq(economyShopListings.id, input.id))
      .get()!;
  }
  getDb()
    .insert(economyShopListings)
    .values({
      guildId,
      shopId: input.shopId,
      itemId: input.itemId,
      price: input.price,
      currencyKey: input.currencyKey ?? "coins",
      stock: input.stock ?? null,
      maxPerUser: input.maxPerUser ?? null,
      restockAmount: input.restockAmount ?? null,
      restockIntervalSeconds: input.restockIntervalSeconds ?? null,
      nextRestockAt:
        input.restockIntervalSeconds && input.restockIntervalSeconds > 0
          ? new Date(Date.now() + input.restockIntervalSeconds * 1000)
          : null,
      enabled: input.enabled ?? true,
      sortOrder: input.sortOrder ?? 0,
    })
    .run();
  return getDb()
    .select()
    .from(economyShopListings)
    .where(and(eq(economyShopListings.guildId, guildId), eq(economyShopListings.shopId, input.shopId)))
    .all()
    .at(-1)!;
}

export function deleteListing(guildId: string, id: number) {
  getDb()
    .delete(economyShopListings)
    .where(and(eq(economyShopListings.guildId, guildId), eq(economyShopListings.id, id)))
    .run();
}

export function getInventory(guildId: string, userId: string) {
  return getDb()
    .select()
    .from(economyInventory)
    .where(and(eq(economyInventory.guildId, guildId), eq(economyInventory.userId, userId)))
    .all();
}

export function getInventoryQty(guildId: string, userId: string, itemId: number): number {
  const row = getDb()
    .select()
    .from(economyInventory)
    .where(
      and(
        eq(economyInventory.guildId, guildId),
        eq(economyInventory.userId, userId),
        eq(economyInventory.itemId, itemId),
      ),
    )
    .get();
  return row?.quantity ?? 0;
}

export function addInventory(
  guildId: string,
  userId: string,
  itemId: number,
  qty: number,
  config: EconomyConfig,
) {
  if (qty <= 0) throw new EconomyError("Quantity must be positive.", "invalid");
  const db = getDb();
  const item = getItemById(guildId, itemId);
  if (!item) throw new EconomyError("Item not found.", "not_found");
  const existing = db
    .select()
    .from(economyInventory)
    .where(
      and(
        eq(economyInventory.guildId, guildId),
        eq(economyInventory.userId, userId),
        eq(economyInventory.itemId, itemId),
      ),
    )
    .get();
  if (!existing) {
    const stacks = getInventory(guildId, userId).filter((r) => r.quantity > 0).length;
    if (stacks >= config.inventory.max_slots) {
      throw new EconomyError("Inventory is full.", "limit");
    }
    const nextQty = Math.min(qty, config.inventory.max_stack);
    db.insert(economyInventory)
      .values({
        guildId,
        userId,
        itemId,
        quantity: nextQty,
        equipped: false,
        updatedAt: now(),
      })
      .run();
    return nextQty;
  }
  const next = Math.min(existing.quantity + qty, config.inventory.max_stack);
  if (next === existing.quantity && qty > 0) {
    throw new EconomyError("Stack limit reached.", "limit");
  }
  db.update(economyInventory)
    .set({ quantity: next, updatedAt: now() })
    .where(
      and(
        eq(economyInventory.guildId, guildId),
        eq(economyInventory.userId, userId),
        eq(economyInventory.itemId, itemId),
      ),
    )
    .run();
  return next;
}

export function removeInventory(guildId: string, userId: string, itemId: number, qty: number) {
  if (qty <= 0) throw new EconomyError("Quantity must be positive.", "invalid");
  const db = getDb();
  const existing = db
    .select()
    .from(economyInventory)
    .where(
      and(
        eq(economyInventory.guildId, guildId),
        eq(economyInventory.userId, userId),
        eq(economyInventory.itemId, itemId),
      ),
    )
    .get();
  if (!existing || existing.quantity < qty) {
    const item = getItemById(guildId, itemId);
    throw new EconomyError(
      item ? `You do not have enough ${item.name}.` : "Not enough items.",
      "insufficient",
      {
        kind: "items",
        itemName: item?.name,
        itemEmoji: item?.emoji,
        required: qty,
        available: existing?.quantity ?? 0,
      },
    );
  }
  const next = existing.quantity - qty;
  if (next <= 0) {
    db.delete(economyInventory)
      .where(
        and(
          eq(economyInventory.guildId, guildId),
          eq(economyInventory.userId, userId),
          eq(economyInventory.itemId, itemId),
        ),
      )
      .run();
    return 0;
  }
  db.update(economyInventory)
    .set({ quantity: next, updatedAt: now() })
    .where(
      and(
        eq(economyInventory.guildId, guildId),
        eq(economyInventory.userId, userId),
        eq(economyInventory.itemId, itemId),
      ),
    )
    .run();
  return next;
}

export function buyFromShop(opts: {
  guildId: string;
  userId: string;
  listingId: number;
  quantity: number;
  config: EconomyConfig;
}) {
  if (!opts.config.modules.shop) throw new EconomyError("Shop module is disabled.", "invalid");
  if (isGuildPaused(opts.guildId, opts.config)) throw new EconomyError("The economy is paused.", "paused");
  const qty = Math.max(1, Math.floor(opts.quantity));
  const listing = getDb()
    .select()
    .from(economyShopListings)
    .where(and(eq(economyShopListings.guildId, opts.guildId), eq(economyShopListings.id, opts.listingId)))
    .get();
  if (!listing || !listing.enabled) throw new EconomyError("Listing not found.", "not_found");
  const shop = getDb()
    .select()
    .from(economyShops)
    .where(and(eq(economyShops.guildId, opts.guildId), eq(economyShops.id, listing.shopId)))
    .get();
  if (!shop?.enabled) throw new EconomyError("Shop is disabled.", "invalid");
  if (listing.stock !== null && listing.stock !== undefined && listing.stock < qty) {
    const item = getItemById(opts.guildId, listing.itemId);
    throw new EconomyError(
      item ? `${item.name} is low on stock.` : "Not enough stock.",
      "insufficient",
      {
        kind: "stock",
        itemName: item?.name,
        itemEmoji: item?.emoji,
        required: qty,
        available: listing.stock,
      },
    );
  }

  const total = listing.price * qty;
  const db = getDb();
  return db.transaction(() => {
    mutateMoney(
      {
        guildId: opts.guildId,
        userId: opts.userId,
        currencyKey: listing.currencyKey,
        deltaPocket: -total,
        reason: "shop_buy",
        refType: "listing",
        refId: String(listing.id),
        meta: { itemId: listing.itemId, qty, price: listing.price },
      },
      { config: opts.config },
    );
    if (listing.stock !== null && listing.stock !== undefined) {
      db.update(economyShopListings)
        .set({ stock: listing.stock - qty })
        .where(eq(economyShopListings.id, listing.id))
        .run();
    }
    addInventory(opts.guildId, opts.userId, listing.itemId, qty, opts.config);
    return { listing, total, qty };
  });
}

export function sellItem(opts: {
  guildId: string;
  userId: string;
  itemId: number;
  quantity: number;
  config: EconomyConfig;
}) {
  if (!opts.config.modules.shop) throw new EconomyError("Shop module is disabled.", "invalid");
  const item = getItemById(opts.guildId, opts.itemId);
  if (!item) throw new EconomyError("Item not found.", "not_found");
  if (item.sellValue <= 0) throw new EconomyError("This item cannot be sold.", "invalid");
  const qty = Math.max(1, Math.floor(opts.quantity));
  const db = getDb();
  return db.transaction(() => {
    removeInventory(opts.guildId, opts.userId, opts.itemId, qty);
    const credit = item.sellValue * qty;
    mutateMoney(
      {
        guildId: opts.guildId,
        userId: opts.userId,
        currencyKey: item.currencyKey,
        deltaPocket: credit,
        reason: "shop_sell",
        refType: "item",
        refId: String(item.id),
        meta: { qty },
      },
      { config: opts.config },
    );
    return { item, credit, qty };
  });
}

export function setEquipped(guildId: string, userId: string, itemId: number, equipped: boolean) {
  const qty = getInventoryQty(guildId, userId, itemId);
  if (qty <= 0) throw new EconomyError("You do not own that item.", "not_found");
  getDb()
    .update(economyInventory)
    .set({ equipped, updatedAt: now() })
    .where(
      and(
        eq(economyInventory.guildId, guildId),
        eq(economyInventory.userId, userId),
        eq(economyInventory.itemId, itemId),
      ),
    )
    .run();
}

export function useItem(opts: {
  guildId: string;
  userId: string;
  itemId: number;
  config: EconomyConfig;
}) {
  const item = getItemById(opts.guildId, opts.itemId);
  if (!item) throw new EconomyError("Item not found.", "not_found");
  if (item.itemType === "collectible") {
    throw new EconomyError("That item cannot be used.", "invalid");
  }
  removeInventory(opts.guildId, opts.userId, opts.itemId, 1);
  let effect: ItemEffect = {};
  try {
    effect = JSON.parse(item.effectJson || "{}") as ItemEffect;
  } catch {
    effect = {};
  }
  if (effect.type === "boost" && effect.duration_seconds && effect.multiplier_bps) {
    getDb()
      .insert(economyEffects)
      .values({
        guildId: opts.guildId,
        userId: opts.userId,
        key: "reward_boost",
        magnitude: effect.multiplier_bps,
        expiresAt: new Date(Date.now() + effect.duration_seconds * 1000),
        metaJson: JSON.stringify({ itemId: item.id }),
        createdAt: now(),
      })
      .run();
  }
  return { item, effect };
}

export function getActiveRewardBoostBps(guildId: string, userId: string): number {
  const rows = getDb()
    .select()
    .from(economyEffects)
    .where(and(eq(economyEffects.guildId, guildId), eq(economyEffects.userId, userId)))
    .all();
  const nowMs = Date.now();
  let total = 0;
  for (const row of rows) {
    if (row.key !== "reward_boost") continue;
    if (row.expiresAt && row.expiresAt.getTime() <= nowMs) continue;
    total += row.magnitude;
  }
  return total;
}

export function getCooldown(guildId: string, userId: string, key: string) {
  return getDb()
    .select()
    .from(economyCooldowns)
    .where(
      and(
        eq(economyCooldowns.guildId, guildId),
        eq(economyCooldowns.userId, userId),
        eq(economyCooldowns.key, key),
      ),
    )
    .get();
}

export function setCooldown(guildId: string, userId: string, key: string, availableAt: Date, meta?: object) {
  const existing = getCooldown(guildId, userId, key);
  if (existing) {
    getDb()
      .update(economyCooldowns)
      .set({ availableAt, metaJson: JSON.stringify(meta ?? {}) })
      .where(
        and(
          eq(economyCooldowns.guildId, guildId),
          eq(economyCooldowns.userId, userId),
          eq(economyCooldowns.key, key),
        ),
      )
      .run();
  } else {
    getDb()
      .insert(economyCooldowns)
      .values({
        guildId,
        userId,
        key,
        availableAt,
        metaJson: JSON.stringify(meta ?? {}),
      })
      .run();
  }
}

export function assertCooldown(guildId: string, userId: string, key: string) {
  const row = getCooldown(guildId, userId, key);
  if (row && row.availableAt.getTime() > Date.now()) {
    const secs = Math.ceil((row.availableAt.getTime() - Date.now()) / 1000);
    throw new EconomyError(`On cooldown for ${secs}s.`, "limit");
  }
}

export function restockDueListings(guildId: string) {
  const listings = listShopListings(guildId);
  let count = 0;
  for (const listing of listings) {
    if (!listing.restockAmount || !listing.restockIntervalSeconds || !listing.nextRestockAt) continue;
    if (listing.nextRestockAt.getTime() > Date.now()) continue;
    getDb()
      .update(economyShopListings)
      .set({
        stock: (listing.stock ?? 0) + listing.restockAmount,
        nextRestockAt: new Date(Date.now() + listing.restockIntervalSeconds * 1000),
      })
      .where(eq(economyShopListings.id, listing.id))
      .run();
    count += 1;
  }
  return count;
}

export function seedDefaultCatalog(guildId: string) {
  if (listShops(guildId).length > 0 || listItems(guildId).length > 0) return;
  const apple = upsertItem(guildId, {
    key: "apple",
    name: "Apple",
    description: "A crisp apple. Restore a little hunger for pets.",
    emoji: "🍎",
    itemType: "consumable",
    sellValue: 5,
    effectJson: JSON.stringify({ type: "pet_feed", hunger: 20 }),
  });
  const crate = upsertItem(guildId, {
    key: "starter_crate",
    name: "Starter Crate",
    description: "Contains a random small reward.",
    emoji: "🎁",
    itemType: "crate",
    sellValue: 0,
    lootJson: JSON.stringify([
      { itemKey: "apple", weight: 70, qty: 2 },
      { itemKey: "lucky_charm", weight: 30, qty: 1 },
    ]),
  });
  upsertItem(guildId, {
    key: "lucky_charm",
    name: "Lucky Charm",
    description: "+10% rewards for 1 hour.",
    emoji: "🍀",
    itemType: "consumable",
    sellValue: 50,
    effectJson: JSON.stringify({ type: "boost", multiplier_bps: 1000, duration_seconds: 3600 }),
  });
  const shop = upsertShop(guildId, {
    key: "general",
    name: "General Store",
    description: "Everyday goods for your server economy.",
  });
  upsertListing(guildId, { shopId: shop.id, itemId: apple.id, price: 15, stock: 100, restockAmount: 50, restockIntervalSeconds: 86400 });
  upsertListing(guildId, { shopId: shop.id, itemId: crate.id, price: 100, stock: 20, restockAmount: 10, restockIntervalSeconds: 86400 });
}
