import { and, asc, count, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { storeCreditLedger, storeVotes } from "../../db/schema.js";
import { STORE_PRICING } from "./pricing.js";
import { DREAMLINER_ONE_PRODUCT_ID, purchaseProduct } from "./products.js";

/**
 * Store credits: members earn them by voting for Dreamliner on top.gg and spend them on days of
 * Dreamliner One for a server. Every movement is a ledger row, and a balance is the ledger's sum,
 * so credits can't drift or be double-spent.
 */

export type VoteSource = "webhook" | "history";

/** Votes are keyed by user and second: the webhook and the history API describe the same vote
 *  with timestamps that can differ below a second, and nobody can vote twice within 12 hours. */
function voteSecond(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 1000) * 1000);
}

/** Records a vote (idempotent). Returns the vote's id, new or existing. */
export function recordVote(input: {
  userId: string;
  votedAt: Date;
  source: VoteSource;
  topggVoteId?: string | null;
  weight?: number;
}): number {
  const votedAt = voteSecond(input.votedAt);
  const db = getDb();
  db.insert(storeVotes)
    .values({
      userId: input.userId,
      votedAt,
      topggVoteId: input.topggVoteId ?? null,
      weight: input.weight ?? 1,
      source: input.source,
      creditedAt: null,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .run();
  const row = db
    .select({ id: storeVotes.id, topggVoteId: storeVotes.topggVoteId })
    .from(storeVotes)
    .where(and(eq(storeVotes.userId, input.userId), eq(storeVotes.votedAt, votedAt)))
    .get()!;
  // A vote first seen in the history sync gets its top.gg id once the webhook describes it.
  if (input.topggVoteId && !row.topggVoteId) {
    db.update(storeVotes).set({ topggVoteId: input.topggVoteId }).where(eq(storeVotes.id, row.id)).run();
  }
  return row.id;
}

/** Pays one vote's credits if it hasn't been paid yet. Returns the credits paid (0 if already). */
export function creditVote(voteId: number, userId: string): number {
  const now = new Date();
  return getDb().transaction((tx) => {
    const updated = tx
      .update(storeVotes)
      .set({ creditedAt: now })
      .where(and(eq(storeVotes.id, voteId), eq(storeVotes.userId, userId), isNull(storeVotes.creditedAt)))
      .run();
    if (updated.changes === 0) return 0;
    tx.insert(storeCreditLedger)
      .values({ userId, delta: STORE_PRICING.creditsPerVote, kind: "vote", voteId, createdAt: now })
      .run();
    return STORE_PRICING.creditsPerVote;
  });
}

/** Pays every recorded vote of this member that hasn't been paid yet (past votes to claim). */
export function claimUncreditedVotes(userId: string): { votes: number; credits: number } {
  const pending = getDb()
    .select({ id: storeVotes.id })
    .from(storeVotes)
    .where(and(eq(storeVotes.userId, userId), isNull(storeVotes.creditedAt)))
    .orderBy(asc(storeVotes.votedAt))
    .all();
  let votes = 0;
  let credits = 0;
  for (const vote of pending) {
    const paid = creditVote(vote.id, userId);
    if (paid > 0) {
      votes++;
      credits += paid;
    }
  }
  return { votes, credits };
}

export function getCreditBalance(userId: string): number {
  const row = getDb()
    .select({ total: sql<number>`coalesce(sum(${storeCreditLedger.delta}), 0)` })
    .from(storeCreditLedger)
    .where(and(eq(storeCreditLedger.userId, userId), eq(storeCreditLedger.currency, "credits")))
    .get();
  return Number(row?.total ?? 0);
}

export function countUncreditedVotes(userId: string): number {
  const row = getDb()
    .select({ total: count() })
    .from(storeVotes)
    .where(and(eq(storeVotes.userId, userId), isNull(storeVotes.creditedAt)))
    .get();
  return Number(row?.total ?? 0);
}

export function getVoteSummary(userId: string): { total: number; lastVotedAt: Date | null } {
  const row = getDb()
    .select({ total: count(), last: sql<number | null>`max(${storeVotes.votedAt})` })
    .from(storeVotes)
    .where(eq(storeVotes.userId, userId))
    .get();
  return { total: Number(row?.total ?? 0), lastVotedAt: row?.last ? new Date(Number(row.last)) : null };
}

export type LedgerKind = "vote" | "purchase" | "miles_purchase" | "grant" | "refund";

export type LedgerEntry = {
  id: number;
  delta: number;
  kind: LedgerKind;
  currency: "credits" | "miles";
  guildId: string | null;
  days: number | null;
  /** Purchases: the product bought. */
  productId: string | null;
  createdAt: Date;
};

export function listLedger(userId: string, limit = 25): LedgerEntry[] {
  return getDb()
    .select()
    .from(storeCreditLedger)
    .where(eq(storeCreditLedger.userId, userId))
    .orderBy(desc(storeCreditLedger.id))
    .limit(limit)
    .all()
    .map((row) => ({
      id: row.id,
      delta: row.delta,
      kind: (["purchase", "miles_purchase", "grant", "refund"] as const).find((kind) => kind === row.kind) ?? "vote",
      currency: row.currency === "miles" ? "miles" : "credits",
      guildId: row.guildId,
      days: row.days,
      productId: row.productId ?? (row.kind === "purchase" ? "dreamliner-one" : null),
      createdAt: row.createdAt,
    }));
}

export { StorePurchaseError } from "./products.js";

/**
 * Spends credits on days of Dreamliner One for a server. A thin wrapper over purchaseProduct for
 * the "dreamliner-one" product (price and day steps come from the catalog): the balance check, the
 * charge and the One extension happen together or not at all, and days stack on an active grant.
 */
export function purchaseOneDays(input: {
  userId: string;
  guildId: string;
  days: number;
  now?: Date;
  requestId?: string | null;
}): {
  cost: number;
  balance: number;
  expiresAt: Date;
} {
  const receipt = purchaseProduct({
    userId: input.userId,
    productId: DREAMLINER_ONE_PRODUCT_ID,
    input: { guildId: input.guildId, days: input.days },
    requestId: input.requestId ?? null,
    now: input.now,
  });
  return { cost: receipt.cost, balance: receipt.balance, expiresAt: receipt.expiresAt! };
}
