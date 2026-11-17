import { eq, inArray, or } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import {
  planeCardCopies,
  planeCardCopyEvents,
  planeCardFlights,
  planeCardListings,
  planeCardPackOpenings,
  planeCardSetCompletions,
  planeCardTradeItems,
  planeCardTrades,
  planeCardUserState,
  planeCoinLedger,
  planePartsLedger,
} from "../../../db/schema.js";
import { inTx } from "./ledger.js";
import { cancelTradesForUser } from "./trades.js";

/** Stands in for an erased user in the economy ledgers, so totals (burned coins, Parts issued,
 *  pull distribution) stay correct for the health panel without keeping who it was. */
export const ERASED_USER_ID = "erased";

/** Every Hangar row tied to a user, for the personal data export. */
export function exportUserHangarData(userId: string) {
  const db = getDb();
  const copies = db.select().from(planeCardCopies).where(eq(planeCardCopies.ownerId, userId)).all();
  return {
    copies,
    copyEvents: db
      .select()
      .from(planeCardCopyEvents)
      .where(or(eq(planeCardCopyEvents.fromUserId, userId), eq(planeCardCopyEvents.toUserId, userId)))
      .all(),
    state: db.select().from(planeCardUserState).where(eq(planeCardUserState.userId, userId)).all(),
    parts: db.select().from(planePartsLedger).where(eq(planePartsLedger.userId, userId)).all(),
    coins: db.select().from(planeCoinLedger).where(eq(planeCoinLedger.userId, userId)).all(),
    packOpenings: db.select().from(planeCardPackOpenings).where(eq(planeCardPackOpenings.userId, userId)).all(),
    flights: db.select().from(planeCardFlights).where(eq(planeCardFlights.userId, userId)).all(),
    trades: db
      .select()
      .from(planeCardTrades)
      .where(or(eq(planeCardTrades.fromUserId, userId), eq(planeCardTrades.toUserId, userId)))
      .all(),
    listings: db
      .select()
      .from(planeCardListings)
      .where(or(eq(planeCardListings.sellerId, userId), eq(planeCardListings.buyerId, userId)))
      .all(),
    setCompletions: db.select().from(planeCardSetCompletions).where(eq(planeCardSetCompletions.userId, userId)).all(),
  };
}

/**
 * Erases a user's Hangar: their open trades and listings are cancelled (unlocking the other
 * side's cards), their copies are removed from circulation, and their own history rows are
 * deleted. Ledger and pack-opening rows are kept for economy totals but no longer name them.
 * Serial numbers are never reused, so other players' copies keep their numbers.
 */
export function deleteUserHangarData(userId: string): number {
  const db = getDb();
  return inTx(() => {
    let total = cancelTradesForUser(userId);

    const copyIds = db
      .select({ id: planeCardCopies.id })
      .from(planeCardCopies)
      .where(eq(planeCardCopies.ownerId, userId))
      .all()
      .map((r) => r.id);

    // Their trades (now all closed) and items, including other people's copies listed in them.
    const tradeIds = db
      .select({ id: planeCardTrades.id })
      .from(planeCardTrades)
      .where(or(eq(planeCardTrades.fromUserId, userId), eq(planeCardTrades.toUserId, userId)))
      .all()
      .map((r) => r.id);
    if (tradeIds.length) {
      db.delete(planeCardTradeItems).where(inArray(planeCardTradeItems.tradeId, tradeIds)).run();
      total += db.delete(planeCardTrades).where(inArray(planeCardTrades.id, tradeIds)).run().changes;
    }

    total += db.delete(planeCardListings).where(eq(planeCardListings.sellerId, userId)).run().changes;
    db.update(planeCardListings).set({ buyerId: null }).where(eq(planeCardListings.buyerId, userId)).run();

    if (copyIds.length) {
      db.delete(planeCardCopyEvents).where(inArray(planeCardCopyEvents.copyId, copyIds)).run();
      total += db.delete(planeCardCopies).where(inArray(planeCardCopies.id, copyIds)).run().changes;
    }
    // Other players' copy histories keep the event but not who it came from or went to.
    db.update(planeCardCopyEvents).set({ fromUserId: null }).where(eq(planeCardCopyEvents.fromUserId, userId)).run();
    db.update(planeCardCopyEvents).set({ toUserId: null }).where(eq(planeCardCopyEvents.toUserId, userId)).run();

    total += db.delete(planeCardFlights).where(eq(planeCardFlights.userId, userId)).run().changes;
    total += db.delete(planeCardSetCompletions).where(eq(planeCardSetCompletions.userId, userId)).run().changes;
    total += db.delete(planeCardUserState).where(eq(planeCardUserState.userId, userId)).run().changes;

    total += db.update(planePartsLedger).set({ userId: ERASED_USER_ID }).where(eq(planePartsLedger.userId, userId)).run().changes;
    total += db.update(planeCoinLedger).set({ userId: ERASED_USER_ID }).where(eq(planeCoinLedger.userId, userId)).run().changes;
    db.update(planeCoinLedger).set({ counterpartyId: null }).where(eq(planeCoinLedger.counterpartyId, userId)).run();
    total += db
      .update(planeCardPackOpenings)
      .set({ userId: ERASED_USER_ID })
      .where(eq(planeCardPackOpenings.userId, userId))
      .run().changes;
    return total;
  });
}
