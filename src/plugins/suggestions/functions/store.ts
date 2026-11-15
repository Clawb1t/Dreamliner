import { and, asc, count, desc, eq, gte, inArray, like, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import {
  suggestionBlocks,
  suggestionComments,
  suggestionFollows,
  suggestions,
  suggestionVotes,
} from "../../../db/schema.js";
import type { SuggestionDisplayStatus } from "../../../config/schemas/suggestions.js";
import type { SuggestionStatus, VoteValue } from "../constants.js";
import { stateColumns, suggestionState, type SuggestionSort, type SuggestionState } from "./states.js";

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
  /** One flat state (see states.ts); applied on top of status/displayStatus. */
  state?: SuggestionState | null;
  authorId?: string | null;
  q?: string;
  sort?: SuggestionSort;
  limit: number;
  offset: number;
};

/** Per-suggestion vote counts as SQL, for sorting the list by votes. */
function voteCountSql(value: "up" | "down") {
  return sql<number>`(select count(*) from ${suggestionVotes} where ${suggestionVotes.suggestionId} = ${suggestions.id} and ${suggestionVotes.value} = ${value})`;
}

/** "By status" order: the review queue first, then open ones, then each marked status, denied last. */
const STATE_ORDER_SQL = sql`case
  when ${suggestions.status} = 'awaiting_review' then 0
  when ${suggestions.status} = 'denied' then 6
  when ${suggestions.displayStatus} = 'considered' then 2
  when ${suggestions.displayStatus} = 'progress' then 3
  when ${suggestions.displayStatus} = 'implemented' then 4
  when ${suggestions.displayStatus} = 'no' then 5
  else 1 end`;

function listOrder(sort: SuggestionSort | undefined): SQL[] {
  const up = voteCountSql("up");
  const down = voteCountSql("down");
  switch (sort) {
    case "oldest":
      return [asc(suggestions.suggestionNumber)];
    case "top":
      return [desc(sql`${up} - ${down}`), desc(up), desc(suggestions.suggestionNumber)];
    case "controversial":
      // Most split first: the smaller side's size, then how many voted at all.
      return [desc(sql`min(${up}, ${down})`), desc(sql`${up} + ${down}`), desc(suggestions.suggestionNumber)];
    case "pending_oldest":
      return [desc(sql`${suggestions.status} = 'awaiting_review'`), asc(suggestions.createdAt)];
    case "status":
      return [asc(STATE_ORDER_SQL), desc(suggestions.suggestionNumber)];
    default:
      return [desc(suggestions.suggestionNumber)];
  }
}

export async function listSuggestions(guildId: string, query: ListSuggestionsQuery) {
  const filters: SQL[] = [eq(suggestions.guildId, guildId)];
  if (query.status) filters.push(eq(suggestions.status, query.status));
  if (query.displayStatus) filters.push(eq(suggestions.displayStatus, query.displayStatus));
  if (query.state) {
    const columns = stateColumns(query.state);
    filters.push(eq(suggestions.status, columns.status));
    if (columns.displayStatus) filters.push(eq(suggestions.displayStatus, columns.displayStatus));
  }
  if (query.authorId) filters.push(eq(suggestions.authorId, query.authorId));
  if (query.q) {
    const q = query.q.trim();
    // Snowflake first: a user ID is also all digits, so the number check would swallow it.
    if (/^\d{17,20}$/.test(q)) {
      filters.push(eq(suggestions.authorId, q));
    } else if (/^\d+$/.test(q)) {
      filters.push(or(eq(suggestions.suggestionNumber, Number(q)), like(suggestions.content, `%${q}%`))!);
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
    .orderBy(...listOrder(query.sort))
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

export type SuggestionVoter = { userId: string; value: VoteValue; votedAt: Date };

/** One page of who voted and how (oldest vote first), for public votes. */
export async function listVoters(
  suggestionId: number,
  offset: number,
  limit: number,
): Promise<SuggestionVoter[]> {
  const rows = await getDb()
    .select({ userId: suggestionVotes.userId, value: suggestionVotes.value, createdAt: suggestionVotes.createdAt })
    .from(suggestionVotes)
    .where(eq(suggestionVotes.suggestionId, suggestionId))
    .orderBy(asc(suggestionVotes.createdAt), asc(suggestionVotes.userId))
    .limit(limit)
    .offset(offset);
  return rows.map((row) => ({ userId: row.userId, value: row.value as VoteValue, votedAt: row.createdAt }));
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

export type SuggestionComment = {
  id: number;
  suggestionId: number;
  authorId: string;
  content: string;
  anonymous: boolean;
  createdAt: Date;
};

function mapComment(row: typeof suggestionComments.$inferSelect): SuggestionComment {
  return {
    id: row.id,
    suggestionId: row.suggestionId,
    authorId: row.authorId,
    content: row.content,
    anonymous: row.anonymous,
    createdAt: row.createdAt,
  };
}

export async function addComment(input: {
  suggestionId: number;
  authorId: string;
  content: string;
  anonymous: boolean;
}): Promise<SuggestionComment> {
  const inserted = await getDb()
    .insert(suggestionComments)
    .values({
      suggestionId: input.suggestionId,
      authorId: input.authorId,
      content: input.content,
      anonymous: input.anonymous,
      createdAt: new Date(),
    })
    .returning();
  return mapComment(inserted[0]!);
}

export async function listComments(suggestionId: number, limit = 25): Promise<SuggestionComment[]> {
  const rows = await getDb()
    .select()
    .from(suggestionComments)
    .where(eq(suggestionComments.suggestionId, suggestionId))
    .orderBy(asc(suggestionComments.createdAt))
    .limit(limit);
  return rows.map(mapComment);
}

export async function countComments(suggestionId: number): Promise<number> {
  const row = await getDb()
    .select({ value: count() })
    .from(suggestionComments)
    .where(eq(suggestionComments.suggestionId, suggestionId))
    .get();
  return Number(row?.value ?? 0);
}

/** Deletes a comment, only if it belongs to this suggestion (callers check the suggestion's server). */
export async function deleteComment(id: number, suggestionId: number): Promise<boolean> {
  const deleted = await getDb()
    .delete(suggestionComments)
    .where(and(eq(suggestionComments.id, id), eq(suggestionComments.suggestionId, suggestionId)))
    .returning();
  return deleted.length > 0;
}

/** Comment counts for many suggestions at once (missing ids have none). */
export async function countCommentsFor(suggestionIds: number[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (suggestionIds.length === 0) return counts;
  const rows = await getDb()
    .select({ suggestionId: suggestionComments.suggestionId, value: count() })
    .from(suggestionComments)
    .where(inArray(suggestionComments.suggestionId, suggestionIds))
    .groupBy(suggestionComments.suggestionId);
  for (const row of rows) counts.set(row.suggestionId, Number(row.value));
  return counts;
}

export async function countFollowers(suggestionId: number): Promise<number> {
  const row = await getDb()
    .select({ value: count() })
    .from(suggestionFollows)
    .where(eq(suggestionFollows.suggestionId, suggestionId))
    .get();
  return Number(row?.value ?? 0);
}

export type SuggestionOverview = {
  total: number;
  byState: Record<SuggestionState, number>;
  createdLast7d: number;
  createdLast30d: number;
  implementedLast30d: number;
  /** Suggestions submitted per day, oldest first, for the last 30 days (today last). */
  daily: number[];
  votes: { up: number; mid: number; down: number; total: number };
  /** Average up minus down across approved suggestions (0 when there are none). */
  avgNetVotes: number;
  comments: number;
  blocked: number;
};

const DAY_MS = 86_400_000;

/** Every number on the dashboard's stats row, in a handful of grouped queries. */
export async function suggestionOverview(guildId: string, now = Date.now()): Promise<SuggestionOverview> {
  const db = getDb();
  const since30 = new Date(now - 30 * DAY_MS);
  const since7 = now - 7 * DAY_MS;

  const [stateRows, recentRows, implementedRow, voteRows, commentRow, blockRow] = await Promise.all([
    db
      .select({ status: suggestions.status, displayStatus: suggestions.displayStatus, value: count() })
      .from(suggestions)
      .where(eq(suggestions.guildId, guildId))
      .groupBy(suggestions.status, suggestions.displayStatus),
    db
      .select({ createdAt: suggestions.createdAt })
      .from(suggestions)
      .where(and(eq(suggestions.guildId, guildId), gte(suggestions.createdAt, since30))),
    db
      .select({ value: count() })
      .from(suggestions)
      .where(and(eq(suggestions.guildId, guildId), gte(suggestions.implementedAt, since30)))
      .get(),
    db
      .select({ status: suggestions.status, value: suggestionVotes.value, n: count() })
      .from(suggestionVotes)
      .innerJoin(suggestions, eq(suggestionVotes.suggestionId, suggestions.id))
      .where(eq(suggestions.guildId, guildId))
      .groupBy(suggestions.status, suggestionVotes.value),
    db
      .select({ value: count() })
      .from(suggestionComments)
      .innerJoin(suggestions, eq(suggestionComments.suggestionId, suggestions.id))
      .where(eq(suggestions.guildId, guildId))
      .get(),
    db.select({ value: count() }).from(suggestionBlocks).where(eq(suggestionBlocks.guildId, guildId)).get(),
  ]);

  const byState: Record<SuggestionState, number> = {
    pending: 0,
    none: 0,
    considered: 0,
    progress: 0,
    implemented: 0,
    no: 0,
    denied: 0,
  };
  let total = 0;
  let approved = 0;
  for (const row of stateRows) {
    const n = Number(row.value);
    byState[suggestionState(row.status, row.displayStatus)] += n;
    total += n;
    if (row.status === "approved") approved += n;
  }

  const daily = Array.from({ length: 30 }, () => 0);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  let createdLast7d = 0;
  for (const row of recentRows) {
    const at = row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt);
    if (at >= since7) createdLast7d += 1;
    // 29 is today, 28 yesterday, and so on.
    const index = 29 + Math.floor((at - todayStart.getTime()) / DAY_MS);
    if (index >= 0 && index < 30) daily[index]! += 1;
  }

  const votes = { up: 0, mid: 0, down: 0, total: 0 };
  let approvedNet = 0;
  for (const row of voteRows) {
    const n = Number(row.n);
    if (row.value === "up") votes.up += n;
    else if (row.value === "mid") votes.mid += n;
    else if (row.value === "down") votes.down += n;
    votes.total += n;
    if (row.status === "approved") approvedNet += row.value === "up" ? n : row.value === "down" ? -n : 0;
  }

  return {
    total,
    byState,
    createdLast7d,
    createdLast30d: recentRows.length,
    implementedLast30d: Number(implementedRow?.value ?? 0),
    daily,
    votes,
    avgNetVotes: approved > 0 ? Math.round((approvedNet / approved) * 10) / 10 : 0,
    comments: Number(commentRow?.value ?? 0),
    blocked: Number(blockRow?.value ?? 0),
  };
}

/** How many suggestions one member has in each state on this server. */
export async function authorSummary(guildId: string, authorId: string): Promise<Record<SuggestionState, number> & { total: number }> {
  const rows = await getDb()
    .select({ status: suggestions.status, displayStatus: suggestions.displayStatus, value: count() })
    .from(suggestions)
    .where(and(eq(suggestions.guildId, guildId), eq(suggestions.authorId, authorId)))
    .groupBy(suggestions.status, suggestions.displayStatus);
  const summary = { pending: 0, none: 0, considered: 0, progress: 0, implemented: 0, no: 0, denied: 0, total: 0 };
  for (const row of rows) {
    const n = Number(row.value);
    summary[suggestionState(row.status, row.displayStatus)] += n;
    summary.total += n;
  }
  return summary;
}

export async function getBlock(guildId: string, userId: string) {
  const row = await getDb()
    .select()
    .from(suggestionBlocks)
    .where(and(eq(suggestionBlocks.guildId, guildId), eq(suggestionBlocks.userId, userId)))
    .get();
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  return row;
}
