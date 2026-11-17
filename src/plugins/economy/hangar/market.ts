import { and, asc, count, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { planeCardCopies, planeCardListings, planeCardSetMembers, planeCardTypes } from "../../../db/schema.js";
import { getPlaneTypeById } from "../functions/catalog.js";
import { round2 } from "../functions/money.js";
import {
  MARKET_LISTING_MS,
  MARKET_MAX_LISTINGS_PER_USER,
  MARKET_MAX_PRICE,
  MARKET_PAGE_SIZE,
  RARITY_META,
  isLivery,
  isRarity,
  marketFee,
  type Rarity,
} from "./constants.js";
import { assertCapacity, assertOwnedFree, getCopy, lockCopy, logCopyEvent, moveCopy, requireCopy, unlockCopy } from "./copies.js";
import { hangarError } from "./errors.js";
import { burnCoins, inTx, transferCoins } from "./ledger.js";
import { refreshUserScore } from "./score.js";

export type ListingRow = typeof planeCardListings.$inferSelect;

export function getListing(id: number): ListingRow | null {
  return Number.isInteger(id) ? (getDb().select().from(planeCardListings).where(eq(planeCardListings.id, id)).get() ?? null) : null;
}

export function activeListingCount(sellerId: string): number {
  return (
    getDb()
      .select({ n: count() })
      .from(planeCardListings)
      .where(and(eq(planeCardListings.sellerId, sellerId), eq(planeCardListings.status, "active")))
      .get()?.n ?? 0
  );
}

export function createListing(sellerId: string, copyId: number, price: number, at = new Date()): ListingRow {
  const value = round2(Number(price));
  return inTx(() => {
    const copy = requireCopy(copyId);
    assertOwnedFree(copy, sellerId);
    const card = getPlaneTypeById(copy.cardTypeId);
    const floor = RARITY_META[(card?.rarity ?? "common") as Rarity]?.marketFloor ?? 1;
    if (!Number.isFinite(value) || value < floor || value > MARKET_MAX_PRICE) {
      throw hangarError("invalid", "Price must be between {floor} and {max} coins for this card.", { floor, max: MARKET_MAX_PRICE });
    }
    if (activeListingCount(sellerId) >= MARKET_MAX_LISTINGS_PER_USER) {
      throw hangarError("limit", "You can have at most {max} listings at once.", { max: MARKET_MAX_LISTINGS_PER_USER });
    }
    const listing = getDb()
      .insert(planeCardListings)
      .values({ sellerId, copyId: copy.id, price: value, status: "active", createdAt: at, expiresAt: new Date(at.getTime() + MARKET_LISTING_MS) })
      .returning()
      .get();
    lockCopy(copy.id, "listing", listing.id);
    logCopyEvent(copy.id, "list", sellerId, null, { listingId: listing.id, price: value });
    return listing;
  });
}

export function cancelListing(sellerId: string, listingId: number, at = new Date()): ListingRow {
  return inTx(() => {
    const listing = getListing(listingId);
    if (!listing) throw hangarError("not_found", "That listing doesn't exist.");
    if (listing.sellerId !== sellerId) throw hangarError("forbidden", "That isn't your listing.");
    if (listing.status !== "active") throw hangarError("conflict", "That listing is already {status}.", { status: listing.status });
    getDb().update(planeCardListings).set({ status: "cancelled", resolvedAt: at }).where(eq(planeCardListings.id, listing.id)).run();
    unlockCopy(listing.copyId, "listing", listing.id);
    logCopyEvent(listing.copyId, "unlist", sellerId, null, { listingId: listing.id });
    return getListing(listing.id)!;
  });
}

export type BuyResult = { listing: ListingRow; price: number; fee: number; buyerBalance: number };

/**
 * Buys a listing atomically: the buyer pays the full price to the seller, the seller then pays the
 * 5% fee, which is burned, and the copy moves. Conditional updates make two buyers racing for the
 * same listing settle exactly once.
 */
export function buyListing(buyerId: string, listingId: number, at = new Date()): BuyResult {
  // Expire outside the purchase transaction, so the expiry sticks when we refuse the buy.
  const stale = getListing(listingId);
  if (stale && stale.status === "active" && stale.expiresAt <= at) {
    inTx(() => expireListing(stale, at));
    throw hangarError("expired", "That listing has expired.");
  }
  return inTx(() => {
    const listing = getListing(listingId);
    if (!listing) throw hangarError("not_found", "That listing doesn't exist.");
    if (listing.status !== "active") throw hangarError("conflict", "That listing is no longer for sale.");
    if (listing.expiresAt <= at) {
      expireListing(listing, at);
      throw hangarError("expired", "That listing has expired.");
    }
    if (listing.sellerId === buyerId) throw hangarError("invalid", "You can't buy your own listing.");
    const copy = getCopy(listing.copyId);
    if (!copy) throw hangarError("conflict", "That card no longer exists.");
    assertOwnedFree(copy, listing.sellerId, { reason: "listing", ref: listing.id });
    assertCapacity(buyerId, 1);
    const claimed = getDb()
      .update(planeCardListings)
      .set({ status: "sold", buyerId, fee: marketFee(listing.price), resolvedAt: at })
      .where(and(eq(planeCardListings.id, listing.id), eq(planeCardListings.status, "active")))
      .run();
    if (claimed.changes !== 1) throw hangarError("conflict", "That listing is no longer for sale.");
    const fee = marketFee(listing.price);
    const { fromBalance } = transferCoins(buyerId, listing.sellerId, listing.price, { out: "market_buy", in: "market_sale" }, `listing:${listing.id}`);
    if (fee > 0) burnCoins(listing.sellerId, fee, "market_fee", `listing:${listing.id}`);
    moveCopy(copy, buyerId, "market", { listingId: listing.id, price: listing.price, fee });
    refreshUserScore(listing.sellerId);
    refreshUserScore(buyerId);
    return { listing: getListing(listing.id)!, price: listing.price, fee, buyerBalance: fromBalance };
  });
}

function expireListing(listing: ListingRow, at: Date): void {
  const result = getDb()
    .update(planeCardListings)
    .set({ status: "expired", resolvedAt: at })
    .where(and(eq(planeCardListings.id, listing.id), eq(planeCardListings.status, "active")))
    .run();
  if (result.changes === 1) unlockCopy(listing.copyId, "listing", listing.id);
}

export function expireListings(at = new Date()): number {
  const overdue = getDb()
    .select()
    .from(planeCardListings)
    .where(and(eq(planeCardListings.status, "active"), lte(planeCardListings.expiresAt, at)))
    .limit(500)
    .all();
  for (const listing of overdue) inTx(() => expireListing(listing, at));
  return overdue.length;
}

export type MarketFilters = {
  rarity?: string | null;
  livery?: string | null;
  setId?: number | null;
  cardTypeId?: number | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  sellerId?: string | null;
  sort?: "newest" | "price_asc" | "price_desc";
  page?: number;
  pageSize?: number;
};

export type MarketBrowseRow = { listing: ListingRow; copy: typeof planeCardCopies.$inferSelect; card: typeof planeCardTypes.$inferSelect };

export function browseListings(filters: MarketFilters = {}, at = new Date()): { rows: MarketBrowseRow[]; total: number; page: number; pageSize: number } {
  const pageSize = Math.max(1, Math.min(50, Math.floor(filters.pageSize ?? MARKET_PAGE_SIZE)));
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const conditions: SQL[] = [eq(planeCardListings.status, "active"), gte(planeCardListings.expiresAt, at)];
  if (filters.rarity && isRarity(filters.rarity)) conditions.push(eq(planeCardTypes.rarity, filters.rarity));
  if (filters.livery && isLivery(filters.livery)) conditions.push(eq(planeCardCopies.livery, filters.livery));
  if (filters.cardTypeId) conditions.push(eq(planeCardCopies.cardTypeId, filters.cardTypeId));
  if (filters.minPrice != null && Number.isFinite(filters.minPrice)) conditions.push(gte(planeCardListings.price, filters.minPrice));
  if (filters.maxPrice != null && Number.isFinite(filters.maxPrice)) conditions.push(lte(planeCardListings.price, filters.maxPrice));
  if (filters.sellerId) conditions.push(eq(planeCardListings.sellerId, filters.sellerId));
  if (filters.setId) {
    const ids = getDb().select({ id: planeCardSetMembers.cardTypeId }).from(planeCardSetMembers).where(eq(planeCardSetMembers.setId, filters.setId)).all().map((r) => r.id);
    if (!ids.length) return { rows: [], total: 0, page, pageSize };
    conditions.push(inArray(planeCardCopies.cardTypeId, ids));
  }
  const where = and(...conditions);
  const base = getDb()
    .select({ listing: planeCardListings, copy: planeCardCopies, card: planeCardTypes })
    .from(planeCardListings)
    .innerJoin(planeCardCopies, eq(planeCardCopies.id, planeCardListings.copyId))
    .innerJoin(planeCardTypes, eq(planeCardTypes.id, planeCardCopies.cardTypeId))
    .where(where);
  const order =
    filters.sort === "price_asc"
      ? [asc(planeCardListings.price), asc(planeCardListings.id)]
      : filters.sort === "price_desc"
        ? [desc(planeCardListings.price), desc(planeCardListings.id)]
        : [desc(planeCardListings.id)];
  const rows = base.orderBy(...order).limit(pageSize).offset((page - 1) * pageSize).all();
  const total =
    getDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(planeCardListings)
      .innerJoin(planeCardCopies, eq(planeCardCopies.id, planeCardListings.copyId))
      .innerJoin(planeCardTypes, eq(planeCardTypes.id, planeCardCopies.cardTypeId))
      .where(where)
      .get()?.n ?? 0;
  return { rows, total: Number(total), page, pageSize };
}

export function listUserListings(sellerId: string, limit = 50): ListingRow[] {
  return getDb()
    .select()
    .from(planeCardListings)
    .where(eq(planeCardListings.sellerId, sellerId))
    .orderBy(desc(planeCardListings.id))
    .limit(limit)
    .all();
}
