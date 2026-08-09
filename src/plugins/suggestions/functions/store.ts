import { and, asc, count, desc, eq, like, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import {
  suggestionBlocks,
  suggestionFollows,
  suggestions,
  suggestionVotes,
} from "../../../db/schema.js";
import type { SuggestionDisplayStatus } from "../../../config/schemas/suggestions.js";
import type { SuggestionStatus, VoteValue } from "../constants.js";

export type Suggestion = {
  id: number;
  guildId: string;
  suggestionNumber: number;
  authorId: string;
  content: string;
  attachmentUrl: string | null;
  anonymous: boolean;
  status: SuggestionStatus;
  displayStatus: SuggestionDisplayStatus;
  reviewChannelId: string | null;
  reviewMessageId: string | null;
  feedChannelId: string | null;
  feedMessageId: string | null;
  deniedChannelId: string | null;
  deniedMessageId: string | null;
  archiveChannelId: string | null;
  archiveMessageId: string | null;
  staffActorId: string | null;
  denialReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  implementedAt: Date | null;
};

export type VoteTotals = { up: number; mid: number; down: number; net: number };

function mapSuggestion(row: typeof suggestions.$inferSelect): Suggestion {
  return {
    id: row.id,
    guildId: row.guildId,
    suggestionNumber: row.suggestionNumber,
    authorId: row.authorId,
    content: row.content,
    attachmentUrl: row.attachmentUrl,
    anonymous: row.anonymous,
    status: row.status as SuggestionStatus,
    displayStatus: row.displayStatus as SuggestionDisplayStatus,
    reviewChannelId: row.reviewChannelId,
    reviewMessageId: row.reviewMessageId,
    feedChannelId: row.feedChannelId,
    feedMessageId: row.feedMessageId,
    deniedChannelId: row.deniedChannelId,
    deniedMessageId: row.deniedMessageId,
    archiveChannelId: row.archiveChannelId,
    archiveMessageId: row.archiveMessageId,
    staffActorId: row.staffActorId,
    denialReason: row.denialReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    implementedAt: row.implementedAt,
  };
}

export async function nextSuggestionNumber(guildId: string): Promise<number> {
  const row = await getDb()
    .select({ max: sql<number>`max(${suggestions.suggestionNumber})` })
    .from(suggestions)
    .where(eq(suggestions.guildId, guildId))
    .get();
  return Number(row?.max ?? 0) + 1;
}

export async function createSuggestion(input: {
  guildId: string;
  authorId: string;
  content: string;
  attachmentUrl?: string | null;
  anonymous: boolean;
  status: SuggestionStatus;
}): Promise<Suggestion> {
  const now = new Date();
  const suggestionNumber = await nextSuggestionNumber(input.guildId);
  const inserted = await getDb()
    .insert(suggestions)
    .values({
      guildId: input.guildId,
      suggestionNumber,
      authorId: input.authorId,
      content: input.content,
      attachmentUrl: input.attachmentUrl ?? null,
      anonymous: input.anonymous,
      status: input.status,
      displayStatus: "none",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return mapSuggestion(inserted[0]!);
}

export async function getSuggestionById(id: number): Promise<Suggestion | null> {
  const row = await getDb().select().from(suggestions).where(eq(suggestions.id, id)).get();
  return row ? mapSuggestion(row) : null;
}

export async function getSuggestionByNumber(
  guildId: string,
  suggestionNumber: number,
): Promise<Suggestion | null> {
  const row = await getDb()
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.guildId, guildId), eq(suggestions.suggestionNumber, suggestionNumber)))
    .get();
  return row ? mapSuggestion(row) : null;
}

export async function updateSuggestion(
  id: number,
  patch: Partial<{
    status: SuggestionStatus;
    displayStatus: SuggestionDisplayStatus;
    reviewChannelId: string | null;
    reviewMessageId: string | null;
    feedChannelId: string | null;
    feedMessageId: string | null;
    deniedChannelId: string | null;
    deniedMessageId: string | null;
    archiveChannelId: string | null;
    archiveMessageId: string | null;
    staffActorId: string | null;
    denialReason: string | null;
    content: string;
    attachmentUrl: string | null;
    implementedAt: Date | null;
  }>,
): Promise<Suggestion | null> {
  const updated = await getDb()
    .update(suggestions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(suggestions.id, id))
    .returning();
  return updated[0] ? mapSuggestion(updated[0]) : null;
}

export async function getLastSuggestionAt(guildId: string, authorId: string): Promise<Date | null> {
  const row = await getDb()
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.guildId, guildId), eq(suggestions.authorId, authorId)))
    .orderBy(desc(suggestions.createdAt))
    .limit(1)
    .get();
  return row?.createdAt ?? null;
}

export async function countOpenApproved(guildId: string, authorId: string): Promise<number> {
  const row = await getDb()
    .select({ value: count() })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.guildId, guildId),
        eq(suggestions.authorId, authorId),
        eq(suggestions.status, "approved"),
        eq(suggestions.displayStatus, "none"),
      ),
    )
    .get();
  return Number(row?.value ?? 0);
}

export type ListSuggestionsQuery = {
  status?: SuggestionStatus | null;
  displayStatus?: string | null;
  authorId?: string | null;
  q?: string;
  limit: number;
  offset: number;
};

export async function listSuggestions(guildId: string, query: ListSuggestionsQuery) {
  const filters: SQL[] = [eq(suggestions.guildId, guildId)];
  if (query.status) filters.push(eq(suggestions.status, query.status));
  if (query.displayStatus) filters.push(eq(suggestions.displayStatus, query.displayStatus));
  if (query.authorId) filters.push(eq(suggestions.authorId, query.authorId));
  if (query.q) {
    const q = query.q.trim();
    if (/^\d+$/.test(q)) {
      filters.push(or(eq(suggestions.suggestionNumber, Number(q)), like(suggestions.content, `%${q}%`))!);
    } else if (/^\d{17,20}$/.test(q)) {
      filters.push(eq(suggestions.authorId, q));
    } else {
      filters.push(like(suggestions.content, `%${q}%`));
    }
  }
  const where = and(...filters)!;
  const db = getDb();
  const [totalRow] = await db.select({ value: count() }).from(suggestions).where(where);
  const rows = await db
    .select()
    .from(suggestions)
    .where(where)
    .orderBy(desc(suggestions.suggestionNumber))
    .limit(query.limit)
    .offset(query.offset);
  return { suggestions: rows.map(mapSuggestion), total: Number(totalRow?.value ?? 0) };
}

export async function getVoteTotals(suggestionId: number): Promise<VoteTotals> {
  const rows = await getDb()
    .select({ value: suggestionVotes.value, count: count() })
    .from(suggestionVotes)
    .where(eq(suggestionVotes.suggestionId, suggestionId))
    .groupBy(suggestionVotes.value);
  const totals: VoteTotals = { up: 0, mid: 0, down: 0, net: 0 };
  for (const row of rows) {
    const n = Number(row.count);
    if (row.value === "up") totals.up = n;
    else if (row.value === "mid") totals.mid = n;
    else if (row.value === "down") totals.down = n;
  }
  totals.net = totals.up - totals.down;
  return totals;
}

export async function setVote(
  suggestionId: number,
  userId: string,
  value: VoteValue,
): Promise<{ action: "added" | "removed" | "changed"; totals: VoteTotals }> {
  const db = getDb();
  const existing = await db
    .select()
    .from(suggestionVotes)
    .where(and(eq(suggestionVotes.suggestionId, suggestionId), eq(suggestionVotes.userId, userId)))
    .get();

  if (existing?.value === value) {
    await db
      .delete(suggestionVotes)
      .where(and(eq(suggestionVotes.suggestionId, suggestionId), eq(suggestionVotes.userId, userId)));
    return { action: "removed", totals: await getVoteTotals(suggestionId) };
  }

  if (existing) {
    await db
      .update(suggestionVotes)
      .set({ value, createdAt: new Date() })
      .where(and(eq(suggestionVotes.suggestionId, suggestionId), eq(suggestionVotes.userId, userId)));
    return { action: "changed", totals: await getVoteTotals(suggestionId) };
  }

  await db.insert(suggestionVotes).values({
    suggestionId,
    userId,
    value,
    createdAt: new Date(),
  });
  return { action: "added", totals: await getVoteTotals(suggestionId) };
}

export async function isBlocked(guildId: string, userId: string): Promise<boolean> {
  const row = await getDb()
    .select()
    .from(suggestionBlocks)
    .where(and(eq(suggestionBlocks.guildId, guildId), eq(suggestionBlocks.userId, userId)))
    .get();
  if (!row) return false;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    await getDb()
      .delete(suggestionBlocks)
      .where(and(eq(suggestionBlocks.guildId, guildId), eq(suggestionBlocks.userId, userId)));
    return false;
  }
  return true;
}

export async function blockUser(input: {
  guildId: string;
  userId: string;
  reason?: string | null;
  expiresAt?: Date | null;
  createdBy: string;
}): Promise<void> {
  await getDb()
    .insert(suggestionBlocks)
    .values({
      guildId: input.guildId,
      userId: input.userId,
      reason: input.reason ?? null,
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy,
      createdAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [suggestionBlocks.guildId, suggestionBlocks.userId],
      set: {
        reason: input.reason ?? null,
        expiresAt: input.expiresAt ?? null,
        createdBy: input.createdBy,
        createdAt: new Date(),
      },
    });
}

export async function unblockUser(guildId: string, userId: string): Promise<boolean> {
  const deleted = await getDb()
    .delete(suggestionBlocks)
    .where(and(eq(suggestionBlocks.guildId, guildId), eq(suggestionBlocks.userId, userId)))
    .returning();
  return deleted.length > 0;
}

export async function listBlocks(guildId: string) {
  return getDb().select().from(suggestionBlocks).where(eq(suggestionBlocks.guildId, guildId));
}

export async function followSuggestion(suggestionId: number, userId: string): Promise<void> {
  await getDb()
    .insert(suggestionFollows)
    .values({ suggestionId, userId, createdAt: new Date() })
    .onConflictDoNothing();
}

export async function unfollowSuggestion(suggestionId: number, userId: string): Promise<boolean> {
  const deleted = await getDb()
    .delete(suggestionFollows)
    .where(and(eq(suggestionFollows.suggestionId, suggestionId), eq(suggestionFollows.userId, userId)))
    .returning();
  return deleted.length > 0;
}

export async function listFollowers(suggestionId: number): Promise<string[]> {
  const rows = await getDb()
    .select()
    .from(suggestionFollows)
    .where(eq(suggestionFollows.suggestionId, suggestionId));
  return rows.map((r) => r.userId);
}

export async function listFollowedByUser(userId: string, guildId: string) {
  const rows = await getDb()
    .select({ suggestion: suggestions })
    .from(suggestionFollows)
    .innerJoin(suggestions, eq(suggestionFollows.suggestionId, suggestions.id))
    .where(and(eq(suggestionFollows.userId, userId), eq(suggestions.guildId, guildId)))
    .orderBy(desc(suggestions.suggestionNumber))
    .limit(25);
  return rows.map((r) => mapSuggestion(r.suggestion));
}

export async function topSuggestions(
  guildId: string,
  direction: "top" | "bottom",
  limit = 10,
): Promise<Array<Suggestion & { net: number; up: number; down: number }>> {
  const voteSub = getDb()
    .select({
      suggestionId: suggestionVotes.suggestionId,
      up: sql<number>`sum(case when ${suggestionVotes.value} = 'up' then 1 else 0 end)`.as("up"),
      down: sql<number>`sum(case when ${suggestionVotes.value} = 'down' then 1 else 0 end)`.as("down"),
    })
    .from(suggestionVotes)
    .groupBy(suggestionVotes.suggestionId)
    .as("vote_totals");

  const rows = await getDb()
    .select({
      suggestion: suggestions,
      up: sql<number>`coalesce(${voteSub.up}, 0)`,
      down: sql<number>`coalesce(${voteSub.down}, 0)`,
    })
    .from(suggestions)
    .leftJoin(voteSub, eq(suggestions.id, voteSub.suggestionId))
    .where(and(eq(suggestions.guildId, guildId), eq(suggestions.status, "approved")))
    .orderBy(
      direction === "top"
        ? desc(sql`coalesce(${voteSub.up}, 0) - coalesce(${voteSub.down}, 0)`)
        : asc(sql`coalesce(${voteSub.up}, 0) - coalesce(${voteSub.down}, 0)`),
    )
    .limit(limit);

  return rows.map((row) => {
    const up = Number(row.up);
    const down = Number(row.down);
    return { ...mapSuggestion(row.suggestion), up, down, net: up - down };
  });
}

export async function suggestionStats(guildId: string) {
  const rows = await getDb()
    .select({ status: suggestions.status, count: count() })
    .from(suggestions)
    .where(eq(suggestions.guildId, guildId))
    .groupBy(suggestions.status);
  const byStatus: Record<string, number> = { awaiting_review: 0, approved: 0, denied: 0 };
  let total = 0;
  for (const row of rows) {
    byStatus[row.status] = Number(row.count);
    total += Number(row.count);
  }
  return { total, byStatus };
}

export async function countAwaitingReview(guildId: string): Promise<number> {
  const row = await getDb()
    .select({ value: count() })
    .from(suggestions)
    .where(and(eq(suggestions.guildId, guildId), eq(suggestions.status, "awaiting_review")))
    .get();
  return Number(row?.value ?? 0);
}
