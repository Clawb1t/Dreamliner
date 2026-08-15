import { and, eq, lt } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import {
  economyAuctionBids,
  economyAuctionWatches,
  economyAuctions,
  economyMarketListings,
  economyTradeOffers,
  economyTrades,
} from "../../../db/schema.js";
import type { EconomyConfig } from "../../../config/schemas/economy.js";
import {
  EconomyError,
  applyBps,
  freezeToEscrow,
  isGuildPaused,
  mutateMoney,
  releaseEscrow,
} from "./money.js";
import { addInventory, getInventoryQty, getItemById, removeInventory } from "./inventory.js";

function now() {
  return new Date();
}

function bumpRevision(tradeId: number) {
  const trade = getTrade(tradeId);
  if (!trade) return;
  getDb()
    .update(economyTrades)
    .set({
      revision: trade.revision + 1,
      initiatorConfirmed: false,
      partnerConfirmed: false,
      updatedAt: now(),
    })
    .where(eq(economyTrades.id, tradeId))
    .run();
}

export function getTrade(tradeId: number) {
  return getDb().select().from(economyTrades).where(eq(economyTrades.id, tradeId)).get();
}

export function listTradeOffers(tradeId: number) {
  return getDb().select().from(economyTradeOffers).where(eq(economyTradeOffers.tradeId, tradeId)).all();
}

export function startTrade(opts: {
  guildId: string;
  initiatorId: string;
  partnerId: string;
  config: EconomyConfig;
}) {
  if (!opts.config.modules.trading) throw new EconomyError("Trading is disabled.", "invalid");
  if (isGuildPaused(opts.guildId, opts.config)) throw new EconomyError("The economy is paused.", "paused");
  if (opts.initiatorId === opts.partnerId) throw new EconomyError("Cannot trade with yourself.", "invalid");

  const open = getDb()
    .select()
    .from(economyTrades)
    .where(
      and(
        eq(economyTrades.guildId, opts.guildId),
        eq(economyTrades.status, "open"),
      ),
    )
    .all()
    .filter(
      (t) =>
        t.initiatorId === opts.initiatorId ||
        t.partnerId === opts.initiatorId ||
        t.initiatorId === opts.partnerId ||
        t.partnerId === opts.partnerId,
    );
  if (open.length > 0) throw new EconomyError("One of you already has an open trade.", "conflict");

  const expiresAt = new Date(Date.now() + opts.config.market.trade_timeout_seconds * 1000);
  getDb()
    .insert(economyTrades)
    .values({
      guildId: opts.guildId,
      initiatorId: opts.initiatorId,
      partnerId: opts.partnerId,
      status: "open",
      initiatorConfirmed: false,
      partnerConfirmed: false,
      revision: 0,
      expiresAt,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  return getDb()
    .select()
    .from(economyTrades)
    .where(and(eq(economyTrades.guildId, opts.guildId), eq(economyTrades.initiatorId, opts.initiatorId)))
    .all()
    .at(-1)!;
}

function assertTradeParty(trade: NonNullable<ReturnType<typeof getTrade>>, userId: string) {
  if (!trade || trade.status !== "open") throw new EconomyError("Trade is not open.", "invalid");
  if (trade.expiresAt.getTime() <= Date.now()) throw new EconomyError("Trade expired.", "limit");
  if (userId !== trade.initiatorId && userId !== trade.partnerId) {
    throw new EconomyError("You are not part of this trade.", "invalid");
  }
}

export function addTradeOffer(opts: {
  guildId: string;
  tradeId: number;
  userId: string;
  offerType: "currency" | "item";
  currencyKey?: string;
  amount?: number;
  itemId?: number;
  quantity?: number;
  config: EconomyConfig;
}) {
  if (!opts.config.modules.trading) throw new EconomyError("Trading is disabled.", "invalid");
  const trade = getTrade(opts.tradeId);
  if (!trade || trade.guildId !== opts.guildId) throw new EconomyError("Trade not found.", "not_found");
  assertTradeParty(trade, opts.userId);

  const db = getDb();
  return db.transaction(() => {
    if (opts.offerType === "currency") {
      const amount = Math.floor(opts.amount ?? 0);
      const currencyKey = opts.currencyKey ?? "coins";
      if (amount <= 0) throw new EconomyError("Amount must be positive.", "invalid");
      freezeToEscrow({
        guildId: opts.guildId,
        userId: opts.userId,
        currencyKey,
        amount,
        reason: "trade_escrow",
        config: opts.config,
        refType: "trade",
        refId: String(trade.id),
      });
      db.insert(economyTradeOffers)
        .values({
          tradeId: trade.id,
          guildId: opts.guildId,
          userId: opts.userId,
          offerType: "currency",
          currencyKey,
          amount,
          itemId: null,
          quantity: 0,
        })
        .run();
    } else {
      const itemId = opts.itemId;
      const quantity = Math.floor(opts.quantity ?? 0);
      if (!itemId || quantity <= 0) throw new EconomyError("Invalid item offer.", "invalid");
      const item = getItemById(opts.guildId, itemId);
      if (!item || !item.tradeable) throw new EconomyError("Item is not tradeable.", "invalid");
      removeInventory(opts.guildId, opts.userId, itemId, quantity);
      db.insert(economyTradeOffers)
        .values({
          tradeId: trade.id,
          guildId: opts.guildId,
          userId: opts.userId,
          offerType: "item",
          currencyKey: null,
          amount: 0,
          itemId,
          quantity,
        })
        .run();
    }
    bumpRevision(trade.id);
    return getTrade(trade.id)!;
  });
}

export function removeTradeOffer(opts: {
  guildId: string;
  tradeId: number;
  userId: string;
  offerId: number;
  config: EconomyConfig;
}) {
  const trade = getTrade(opts.tradeId);
  if (!trade || trade.guildId !== opts.guildId) throw new EconomyError("Trade not found.", "not_found");
  assertTradeParty(trade, opts.userId);

  const offer = getDb()
    .select()
    .from(economyTradeOffers)
    .where(and(eq(economyTradeOffers.id, opts.offerId), eq(economyTradeOffers.tradeId, trade.id)))
    .get();
  if (!offer || offer.userId !== opts.userId) throw new EconomyError("Offer not found.", "not_found");

  const db = getDb();
  return db.transaction(() => {
    if (offer.offerType === "currency" && offer.currencyKey && offer.amount > 0) {
      releaseEscrow({
        guildId: opts.guildId,
        userId: opts.userId,
        currencyKey: offer.currencyKey,
        amount: offer.amount,
        to: "pocket",
        reason: "trade_escrow_release",
        config: opts.config,
        refType: "trade",
        refId: String(trade.id),
      });
    } else if (offer.offerType === "item" && offer.itemId && offer.quantity > 0) {
      addInventory(opts.guildId, opts.userId, offer.itemId, offer.quantity, opts.config);
    }
    db.delete(economyTradeOffers).where(eq(economyTradeOffers.id, offer.id)).run();
    bumpRevision(trade.id);
    return getTrade(trade.id)!;
  });
}

export function reviewTrade(tradeId: number) {
  const trade = getTrade(tradeId);
  if (!trade) throw new EconomyError("Trade not found.", "not_found");
  return { trade, offers: listTradeOffers(tradeId) };
}

export function confirmTrade(opts: {
  guildId: string;
  tradeId: number;
  userId: string;
  config: EconomyConfig;
}) {
  if (!opts.config.modules.trading) throw new EconomyError("Trading is disabled.", "invalid");
  const trade = getTrade(opts.tradeId);
  if (!trade || trade.guildId !== opts.guildId) throw new EconomyError("Trade not found.", "not_found");
  assertTradeParty(trade, opts.userId);

  const patch =
    opts.userId === trade.initiatorId
      ? { initiatorConfirmed: true, updatedAt: now() }
      : { partnerConfirmed: true, updatedAt: now() };

  getDb().update(economyTrades).set(patch).where(eq(economyTrades.id, trade.id)).run();
  const refreshed = getTrade(trade.id)!;
  if (!refreshed.initiatorConfirmed || !refreshed.partnerConfirmed) {
    return { trade: refreshed, completed: false as const };
  }

  const offers = listTradeOffers(trade.id);
  const db = getDb();
  db.transaction(() => {
    for (const offer of offers) {
      const counterparty =
        offer.userId === trade.initiatorId ? trade.partnerId : trade.initiatorId;
      if (offer.offerType === "currency" && offer.currencyKey && offer.amount > 0) {
        releaseEscrow({
          guildId: opts.guildId,
          userId: offer.userId,
          currencyKey: offer.currencyKey,
          amount: offer.amount,
          to: "other",
          otherUserId: counterparty,
          reason: "trade_complete",
          config: opts.config,
          refType: "trade",
          refId: String(trade.id),
          idempotencyKey: `trade:${trade.id}:cur:${offer.id}`,
        });
      } else if (offer.offerType === "item" && offer.itemId && offer.quantity > 0) {
        addInventory(opts.guildId, counterparty, offer.itemId, offer.quantity, opts.config);
      }
    }
    db.update(economyTrades)
      .set({ status: "completed", updatedAt: now() })
      .where(eq(economyTrades.id, trade.id))
      .run();
  });

  return { trade: getTrade(trade.id)!, completed: true as const };
}

export function cancelTrade(opts: {
  guildId: string;
  tradeId: number;
  userId: string;
  config: EconomyConfig;
  force?: boolean;
}) {
  const trade = getTrade(opts.tradeId);
  if (!trade || trade.guildId !== opts.guildId) throw new EconomyError("Trade not found.", "not_found");
  if (trade.status !== "open") throw new EconomyError("Trade is not open.", "invalid");
  if (!opts.force && opts.userId !== trade.initiatorId && opts.userId !== trade.partnerId) {
    throw new EconomyError("You are not part of this trade.", "invalid");
  }

  const offers = listTradeOffers(trade.id);
  const db = getDb();
  db.transaction(() => {
    for (const offer of offers) {
      if (offer.offerType === "currency" && offer.currencyKey && offer.amount > 0) {
        releaseEscrow({
          guildId: opts.guildId,
          userId: offer.userId,
          currencyKey: offer.currencyKey,
          amount: offer.amount,
          to: "pocket",
          reason: "trade_cancel",
          config: opts.config,
          refType: "trade",
          refId: String(trade.id),
          idempotencyKey: `trade_cancel:${trade.id}:cur:${offer.id}`,
        });
      } else if (offer.offerType === "item" && offer.itemId && offer.quantity > 0) {
        addInventory(opts.guildId, offer.userId, offer.itemId, offer.quantity, opts.config);
      }
    }
    db.delete(economyTradeOffers).where(eq(economyTradeOffers.tradeId, trade.id)).run();
    db.update(economyTrades)
      .set({ status: "cancelled", updatedAt: now() })
      .where(eq(economyTrades.id, trade.id))
      .run();
  });
  return getTrade(trade.id)!;
}

export function expireOpenTrades(guildId: string, config: EconomyConfig) {
  const expired = getDb()
    .select()
    .from(economyTrades)
    .where(and(eq(economyTrades.guildId, guildId), eq(economyTrades.status, "open"), lt(economyTrades.expiresAt, now())))
    .all();
  let count = 0;
  for (const trade of expired) {
    try {
      cancelTrade({
        guildId,
        tradeId: trade.id,
        userId: trade.initiatorId,
        config,
        force: true,
      });
      getDb()
        .update(economyTrades)
        .set({ status: "expired", updatedAt: now() })
        .where(eq(economyTrades.id, trade.id))
        .run();
      count += 1;
    } catch {
      /* ignore individual failures */
    }
  }
  return count;
}

/* ── Marketplace ─────────────────────────────────────────── */

export function listMarketListings(guildId: string, status = "active") {
  return getDb()
    .select()
    .from(economyMarketListings)
    .where(and(eq(economyMarketListings.guildId, guildId), eq(economyMarketListings.status, status)))
    .all();
}

export function createMarketListing(opts: {
  guildId: string;
  sellerId: string;
  itemId: number;
  quantity: number;
  price: number;
  currencyKey?: string;
  config: EconomyConfig;
}) {
  if (!opts.config.modules.marketplace) throw new EconomyError("Marketplace is disabled.", "invalid");
  if (isGuildPaused(opts.guildId, opts.config)) throw new EconomyError("The economy is paused.", "paused");
  const qty = Math.floor(opts.quantity);
  const price = Math.floor(opts.price);
  if (qty <= 0 || price <= 0) throw new EconomyError("Quantity and price must be positive.", "invalid");

  const item = getItemById(opts.guildId, opts.itemId);
  if (!item || !item.tradeable) throw new EconomyError("Item is not tradeable.", "invalid");

  const active = listMarketListings(opts.guildId).filter((l) => l.sellerId === opts.sellerId);
  if (active.length >= opts.config.market.max_listings_per_user) {
    throw new EconomyError("Listing limit reached.", "limit");
  }

  const currencyKey = opts.currencyKey ?? "coins";
  const fee = applyBps(price * qty, opts.config.market.listing_fee_bps);

  const db = getDb();
  return db.transaction(() => {
    if (getInventoryQty(opts.guildId, opts.sellerId, opts.itemId) < qty) {
      throw new EconomyError("Not enough items.", "insufficient");
    }
    removeInventory(opts.guildId, opts.sellerId, opts.itemId, qty);
    if (fee > 0) {
      mutateMoney(
        {
          guildId: opts.guildId,
          userId: opts.sellerId,
          currencyKey,
          deltaPocket: -fee,
          reason: "market_listing_fee",
          meta: { itemId: opts.itemId, qty, price },
        },
        { config: opts.config },
      );
    }
    db.insert(economyMarketListings)
      .values({
        guildId: opts.guildId,
        sellerId: opts.sellerId,
        itemId: opts.itemId,
        quantity: qty,
        price,
        currencyKey,
        status: "active",
        createdAt: now(),
        soldAt: null,
        buyerId: null,
      })
      .run();
    const listing = listMarketListings(opts.guildId).filter((l) => l.sellerId === opts.sellerId).at(-1)!;
    return { listing, fee };
  });
}

export function buyMarketListing(opts: {
  guildId: string;
  buyerId: string;
  listingId: number;
  config: EconomyConfig;
}) {
  if (!opts.config.modules.marketplace) throw new EconomyError("Marketplace is disabled.", "invalid");
  if (isGuildPaused(opts.guildId, opts.config)) throw new EconomyError("The economy is paused.", "paused");

  const listing = getDb()
    .select()
    .from(economyMarketListings)
    .where(and(eq(economyMarketListings.guildId, opts.guildId), eq(economyMarketListings.id, opts.listingId)))
    .get();
  if (!listing || listing.status !== "active") throw new EconomyError("Listing not found.", "not_found");
  if (listing.sellerId === opts.buyerId) throw new EconomyError("Cannot buy your own listing.", "invalid");

  const gross = listing.price * listing.quantity;
  const tax = applyBps(gross, opts.config.market.sale_tax_bps);
  const sellerNet = gross - tax;

  const db = getDb();
  return db.transaction(() => {
    mutateMoney(
      {
        guildId: opts.guildId,
        userId: opts.buyerId,
        currencyKey: listing.currencyKey,
        deltaPocket: -gross,
        reason: "market_buy",
        refType: "listing",
        refId: String(listing.id),
        idempotencyKey: `market_buy:${listing.id}:${opts.buyerId}`,
      },
      { config: opts.config },
    );
    if (sellerNet > 0) {
      mutateMoney(
        {
          guildId: opts.guildId,
          userId: listing.sellerId,
          currencyKey: listing.currencyKey,
          deltaPocket: sellerNet,
          reason: "market_sell",
          refType: "listing",
          refId: String(listing.id),
          idempotencyKey: `market_sell:${listing.id}`,
        },
        { config: opts.config },
      );
    }
    addInventory(opts.guildId, opts.buyerId, listing.itemId, listing.quantity, opts.config);
    db.update(economyMarketListings)
      .set({ status: "sold", soldAt: now(), buyerId: opts.buyerId })
      .where(eq(economyMarketListings.id, listing.id))
      .run();
    return { listing: { ...listing, status: "sold", buyerId: opts.buyerId }, gross, tax, sellerNet };
  });
}

export function cancelMarketListing(opts: {
  guildId: string;
  userId: string;
  listingId: number;
  config: EconomyConfig;
  force?: boolean;
}) {
  const listing = getDb()
    .select()
    .from(economyMarketListings)
    .where(and(eq(economyMarketListings.guildId, opts.guildId), eq(economyMarketListings.id, opts.listingId)))
    .get();
  if (!listing || listing.status !== "active") throw new EconomyError("Listing not found.", "not_found");
  if (!opts.force && listing.sellerId !== opts.userId) {
    throw new EconomyError("Not your listing.", "invalid");
  }
  const db = getDb();
  return db.transaction(() => {
    addInventory(opts.guildId, listing.sellerId, listing.itemId, listing.quantity, opts.config);
    db.update(economyMarketListings)
      .set({ status: "cancelled" })
      .where(eq(economyMarketListings.id, listing.id))
      .run();
    return { ...listing, status: "cancelled" };
  });
}

/* ── Auctions ────────────────────────────────────────────── */

export function listAuctions(guildId: string, status = "active") {
  return getDb()
    .select()
    .from(economyAuctions)
    .where(and(eq(economyAuctions.guildId, guildId), eq(economyAuctions.status, status)))
    .all();
}

export function getAuction(guildId: string, auctionId: number) {
  return getDb()
    .select()
    .from(economyAuctions)
    .where(and(eq(economyAuctions.guildId, guildId), eq(economyAuctions.id, auctionId)))
    .get();
}

export function createAuction(opts: {
  guildId: string;
  sellerId: string;
  itemId: number;
  quantity: number;
  startingBid: number;
  buyoutPrice?: number | null;
  durationSeconds: number;
  currencyKey?: string;
  config: EconomyConfig;
}) {
  if (!opts.config.modules.auctions) throw new EconomyError("Auctions are disabled.", "invalid");
  if (isGuildPaused(opts.guildId, opts.config)) throw new EconomyError("The economy is paused.", "paused");

  const dur = Math.floor(opts.durationSeconds);
  if (dur < opts.config.market.auction_min_duration_seconds) {
    throw new EconomyError("Auction duration too short.", "limit");
  }
  if (dur > opts.config.market.auction_max_duration_seconds) {
    throw new EconomyError("Auction duration too long.", "limit");
  }
  const qty = Math.floor(opts.quantity);
  const startingBid = Math.floor(opts.startingBid);
  if (qty <= 0 || startingBid <= 0) throw new EconomyError("Invalid auction params.", "invalid");
  if (opts.buyoutPrice != null && opts.buyoutPrice > 0 && opts.buyoutPrice < startingBid) {
    throw new EconomyError("Buyout must be >= starting bid.", "invalid");
  }

  const item = getItemById(opts.guildId, opts.itemId);
  if (!item || !item.tradeable) throw new EconomyError("Item is not tradeable.", "invalid");

  const db = getDb();
  return db.transaction(() => {
    removeInventory(opts.guildId, opts.sellerId, opts.itemId, qty);
    db.insert(economyAuctions)
      .values({
        guildId: opts.guildId,
        sellerId: opts.sellerId,
        itemId: opts.itemId,
        quantity: qty,
        currencyKey: opts.currencyKey ?? "coins",
        startingBid,
        buyoutPrice: opts.buyoutPrice ?? null,
        currentBid: 0,
        currentBidderId: null,
        status: "active",
        endsAt: new Date(Date.now() + dur * 1000),
        createdAt: now(),
        settledAt: null,
      })
      .run();
    return listAuctions(opts.guildId).filter((a) => a.sellerId === opts.sellerId).at(-1)!;
  });
}

function minNextBid(auction: NonNullable<ReturnType<typeof getAuction>>, config: EconomyConfig): number {
  if (!auction.currentBidderId || auction.currentBid <= 0) return auction.startingBid;
  const inc = Math.max(1, applyBps(auction.currentBid, config.market.auction_min_increment_bps));
  return auction.currentBid + inc;
}

export function bidOnAuction(opts: {
  guildId: string;
  bidderId: string;
  auctionId: number;
  amount: number;
  config: EconomyConfig;
}) {
  if (!opts.config.modules.auctions) throw new EconomyError("Auctions are disabled.", "invalid");
  if (isGuildPaused(opts.guildId, opts.config)) throw new EconomyError("The economy is paused.", "paused");

  const auction = getAuction(opts.guildId, opts.auctionId);
  if (!auction || auction.status !== "active") throw new EconomyError("Auction not found.", "not_found");
  if (auction.endsAt.getTime() <= Date.now()) throw new EconomyError("Auction has ended.", "limit");
  if (auction.sellerId === opts.bidderId) throw new EconomyError("Cannot bid on your own auction.", "invalid");

  const amount = Math.floor(opts.amount);
  const minBid = minNextBid(auction, opts.config);
  if (amount < minBid) throw new EconomyError(`Minimum bid is ${minBid}.`, "limit");

  const db = getDb();
  return db.transaction(() => {
    if (auction.currentBidderId && auction.currentBid > 0) {
      releaseEscrow({
        guildId: opts.guildId,
        userId: auction.currentBidderId,
        currencyKey: auction.currencyKey,
        amount: auction.currentBid,
        to: "pocket",
        reason: "auction_outbid",
        config: opts.config,
        refType: "auction",
        refId: String(auction.id),
        idempotencyKey: `auction_outbid:${auction.id}:${auction.currentBidderId}:${auction.currentBid}`,
      });
    }
    freezeToEscrow({
      guildId: opts.guildId,
      userId: opts.bidderId,
      currencyKey: auction.currencyKey,
      amount,
      reason: "auction_bid",
      config: opts.config,
      refType: "auction",
      refId: String(auction.id),
    });
    db.insert(economyAuctionBids)
      .values({
        auctionId: auction.id,
        guildId: opts.guildId,
        bidderId: opts.bidderId,
        amount,
        createdAt: now(),
      })
      .run();

    let endsAt = auction.endsAt;
    const antiSnipe = opts.config.market.auction_anti_snipe_seconds * 1000;
    if (antiSnipe > 0 && endsAt.getTime() - Date.now() < antiSnipe) {
      endsAt = new Date(Date.now() + antiSnipe);
    }

    db.update(economyAuctions)
      .set({
        currentBid: amount,
        currentBidderId: opts.bidderId,
        endsAt,
      })
      .where(eq(economyAuctions.id, auction.id))
      .run();

    return getAuction(opts.guildId, auction.id)!;
  });
}

export function buyoutAuction(opts: {
  guildId: string;
  buyerId: string;
  auctionId: number;
  config: EconomyConfig;
}) {
  if (!opts.config.modules.auctions) throw new EconomyError("Auctions are disabled.", "invalid");
  const auction = getAuction(opts.guildId, opts.auctionId);
  if (!auction || auction.status !== "active") throw new EconomyError("Auction not found.", "not_found");
  if (!auction.buyoutPrice || auction.buyoutPrice <= 0) {
    throw new EconomyError("This auction has no buyout.", "invalid");
  }
  if (auction.sellerId === opts.buyerId) throw new EconomyError("Cannot buy out your own auction.", "invalid");

  const db = getDb();
  return db.transaction(() => {
    if (auction.currentBidderId && auction.currentBid > 0) {
      releaseEscrow({
        guildId: opts.guildId,
        userId: auction.currentBidderId,
        currencyKey: auction.currencyKey,
        amount: auction.currentBid,
        to: "pocket",
        reason: "auction_outbid",
        config: opts.config,
        refType: "auction",
        refId: String(auction.id),
        idempotencyKey: `auction_buyout_refund:${auction.id}:${auction.currentBidderId}`,
      });
    }
    freezeToEscrow({
      guildId: opts.guildId,
      userId: opts.buyerId,
      currencyKey: auction.currencyKey,
      amount: auction.buyoutPrice!,
      reason: "auction_buyout",
      config: opts.config,
      refType: "auction",
      refId: String(auction.id),
    });
    db.update(economyAuctions)
      .set({
        currentBid: auction.buyoutPrice!,
        currentBidderId: opts.buyerId,
        endsAt: now(),
        status: "ended",
      })
      .where(eq(economyAuctions.id, auction.id))
      .run();
    settleAuction(opts.guildId, auction.id, opts.config);
    return getAuction(opts.guildId, auction.id)!;
  });
}

export function watchAuction(guildId: string, auctionId: number, userId: string) {
  const auction = getAuction(guildId, auctionId);
  if (!auction) throw new EconomyError("Auction not found.", "not_found");
  const existing = getDb()
    .select()
    .from(economyAuctionWatches)
    .where(
      and(
        eq(economyAuctionWatches.guildId, guildId),
        eq(economyAuctionWatches.auctionId, auctionId),
        eq(economyAuctionWatches.userId, userId),
      ),
    )
    .get();
  if (existing) return existing;
  getDb()
    .insert(economyAuctionWatches)
    .values({ guildId, auctionId, userId })
    .run();
  return { guildId, auctionId, userId };
}

export function unwatchAuction(guildId: string, auctionId: number, userId: string) {
  getDb()
    .delete(economyAuctionWatches)
    .where(
      and(
        eq(economyAuctionWatches.guildId, guildId),
        eq(economyAuctionWatches.auctionId, auctionId),
        eq(economyAuctionWatches.userId, userId),
      ),
    )
    .run();
}

/** Idempotent settlement of a single auction. */
export function settleAuction(guildId: string, auctionId: number, config: EconomyConfig) {
  const auction = getAuction(guildId, auctionId);
  if (!auction) return null;
  if (auction.settledAt) return auction;
  if (auction.status === "active" && auction.endsAt.getTime() > Date.now()) return auction;

  const db = getDb();
  return db.transaction(() => {
    const fresh = getAuction(guildId, auctionId);
    if (!fresh || fresh.settledAt) return fresh;

    if (fresh.currentBidderId && fresh.currentBid > 0) {
      const tax = applyBps(fresh.currentBid, config.market.sale_tax_bps);
      const sellerNet = fresh.currentBid - tax;
      releaseEscrow({
        guildId,
        userId: fresh.currentBidderId,
        currencyKey: fresh.currencyKey,
        amount: fresh.currentBid,
        to: "other",
        otherUserId: fresh.sellerId,
        reason: "auction_settle",
        config,
        refType: "auction",
        refId: String(fresh.id),
        idempotencyKey: `auction_settle:${fresh.id}`,
      });
      // releaseEscrow to other credits full amount; sink tax from seller
      if (tax > 0) {
        mutateMoney(
          {
            guildId,
            userId: fresh.sellerId,
            currencyKey: fresh.currencyKey,
            deltaPocket: -tax,
            reason: "auction_tax",
            refType: "auction",
            refId: String(fresh.id),
            idempotencyKey: `auction_tax:${fresh.id}`,
            allowFrozenAccount: true,
          },
          { config, skipPauseCheck: true },
        );
      }
      addInventory(guildId, fresh.currentBidderId, fresh.itemId, fresh.quantity, config);
      void sellerNet;
      db.update(economyAuctions)
        .set({ status: "sold", settledAt: now() })
        .where(eq(economyAuctions.id, fresh.id))
        .run();
    } else {
      addInventory(guildId, fresh.sellerId, fresh.itemId, fresh.quantity, config);
      db.update(economyAuctions)
        .set({ status: "expired", settledAt: now() })
        .where(eq(economyAuctions.id, fresh.id))
        .run();
    }
    return getAuction(guildId, auctionId);
  });
}

export function settleExpiredAuctions(guildId: string, config: EconomyConfig) {
  const due = getDb()
    .select()
    .from(economyAuctions)
    .where(and(eq(economyAuctions.guildId, guildId), eq(economyAuctions.status, "active"), lt(economyAuctions.endsAt, now())))
    .all();
  // also settle buyout-ended without settledAt
  const ended = getDb()
    .select()
    .from(economyAuctions)
    .where(and(eq(economyAuctions.guildId, guildId), eq(economyAuctions.status, "ended")))
    .all()
    .filter((a) => !a.settledAt);

  let count = 0;
  for (const auction of [...due, ...ended]) {
    const result = settleAuction(guildId, auction.id, config);
    if (result?.settledAt) count += 1;
  }
  return count;
}
