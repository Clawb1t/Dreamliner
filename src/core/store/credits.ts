import { and, asc, count, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { guildOneSubscriptions, storeCreditLedger, storeVotes } from "../../db/schema.js";
import { STORE_PRICING, isValidPurchaseDays, purchaseCost } from "./pricing.js";

/**
 * Store credits: members earn them by voting for Dreamliner on top.gg and spend them on days of
 * Dreamliner One for a server. Every movement is a ledger row, and a balance is the ledger's sum,
 * so credits can't drift or be double-spent.
 */

const DAY_MS = 86_400_000;

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
    .where(eq(storeCreditLedger.userId, userId))
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

export type LedgerEntry = {
  id: number;
  delta: number;
  kind: "vote" | "purchase";
  guildId: string | null;
  days: number | null;
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
      kind: row.kind === "purchase" ? "purchase" : "vote",
      guildId: row.guildId,
      days: row.days,
      createdAt: row.createdAt,
    }));
}

export class StorePurchaseError extends Error {
  constructor(
    readonly code: "invalid_days" | "insufficient_credits" | "one_forever",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Spends credits on days of Dreamliner One for a server, in one transaction: the balance check,
 * the charge and the One extension all happen together or not at all. Days stack on top of an
 * active grant; an expired or revoked grant starts fresh from now.
 */
export function purchaseOneDays(input: { userId: string; guildId: string; days: number; now?: Date }): {
  cost: number;
  balance: number;
  expiresAt: Date;
} {
  if (!isValidPurchaseDays(input.days)) {
    throw new StorePurchaseError(
      "invalid_days",
      `Pick ${STORE_PRICING.dayStep} to ${STORE_PRICING.maxDaysPerPurchase} days, in steps of ${STORE_PRICING.dayStep}.`,
    );
  }
  const cost = purchaseCost(input.days);
  const now = input.now ?? new Date();

  return getDb().transaction((tx) => {
    const balanceRow = tx
      .select({ total: sql<number>`coalesce(sum(${storeCreditLedger.delta}), 0)` })
      .from(storeCreditLedger)
      .where(eq(storeCreditLedger.userId, input.userId))
      .get();
    const balance = Number(balanceRow?.total ?? 0);
    if (balance < cost) {
      throw new StorePurchaseError("insufficient_credits", `You need ${cost} credits for ${input.days} days.`);
    }

    const row = tx.select().from(guildOneSubscriptions).where(eq(guildOneSubscriptions.guildId, input.guildId)).get();
    const active = row && !row.revokedAt && (row.expiresAt === null || row.expiresAt.getTime() > now.getTime());
    if (active && row.expiresAt === null) {
      throw new StorePurchaseError("one_forever", "This server already has Dreamliner One for good.");
    }

    const base = active && row.expiresAt ? row.expiresAt.getTime() : now.getTime();
    const expiresAt = new Date(base + input.days * DAY_MS);

    if (!row) {
      tx.insert(guildOneSubscriptions)
        .values({
          guildId: input.guildId,
          expiresAt,
          note: "Store credits",
          grantedBy: input.userId,
          grantedAt: now,
          updatedBy: input.userId,
          updatedAt: now,
          revokedAt: null,
        })
        .run();
    } else if (active) {
      // Extending a live grant keeps who granted it and its note.
      tx.update(guildOneSubscriptions)
        .set({ expiresAt, updatedBy: input.userId, updatedAt: now })
        .where(eq(guildOneSubscriptions.guildId, input.guildId))
        .run();
    } else {
      tx.update(guildOneSubscriptions)
        .set({
          expiresAt,
          note: "Store credits",
          grantedBy: input.userId,
          grantedAt: now,
          updatedBy: input.userId,
          updatedAt: now,
          revokedAt: null,
        })
        .where(eq(guildOneSubscriptions.guildId, input.guildId))
        .run();
    }

    tx.insert(storeCreditLedger)
      .values({
        userId: input.userId,
        delta: -cost,
        kind: "purchase",
        guildId: input.guildId,
        days: input.days,
        createdAt: now,
      })
      .run();

    return { cost, balance: balance - cost, expiresAt };
  });
}
