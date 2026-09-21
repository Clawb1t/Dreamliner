import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { giveawayEntries, giveaways, reviews, suggestionVotes, suggestions } from "../../../db/schema.js";
import { dateRange, isAllTimeWindow, resolveFilledWindow } from "./daily.js";

function sinceBoundary(days: number): Date | null {
  if (isAllTimeWindow(days)) return null;
  const since = dateRange(days)[0]!;
  return new Date(`${since}T00:00:00.000Z`);
}

export type GiveawayDailyRow = { statDate: string; created: number; entries: number };

/** Giveaways created per day and giveaway entries per day, zero-filled over the window.
 *  giveaway_entries has no guildId of its own, so entries are scoped via a join through
 *  giveaways.guildId. */
export async function getFilledGiveawayDaily(guildId: string, days: number = 14): Promise<GiveawayDailyRow[]> {
  const db = getDb();
  const since = sinceBoundary(days);

  const createdFilters = [eq(giveaways.guildId, guildId)];
  if (since) createdFilters.push(gte(giveaways.createdAt, since));
  const createdRows = await db
    .select({
      statDate: sql<string>`date(${giveaways.createdAt}, 'unixepoch')`,
      count: sql<number>`count(*)`,
    })
    .from(giveaways)
    .where(and(...createdFilters))
    .groupBy(sql`date(${giveaways.createdAt}, 'unixepoch')`);

  const entryFilters = [eq(giveaways.guildId, guildId)];
  if (since) entryFilters.push(gte(giveawayEntries.enteredAt, since));
  const entryRows = await db
    .select({
      statDate: sql<string>`date(${giveawayEntries.enteredAt}, 'unixepoch')`,
      count: sql<number>`count(*)`,
    })
    .from(giveawayEntries)
    .innerJoin(giveaways, eq(giveawayEntries.giveawayId, giveaways.id))
    .where(and(...entryFilters))
    .groupBy(sql`date(${giveawayEntries.enteredAt}, 'unixepoch')`);

  const createdMap = new Map(createdRows.map((row) => [row.statDate, row.count]));
  const entryMap = new Map(entryRows.map((row) => [row.statDate, row.count]));

  const dates = isAllTimeWindow(days)
    ? resolveFilledWindow(days, [...createdMap.keys(), ...entryMap.keys()])
    : dateRange(days);

  return dates.map((date) => ({
    statDate: date,
    created: createdMap.get(date) ?? 0,
    entries: entryMap.get(date) ?? 0,
  }));
}

export type SuggestionDailyRow = { statDate: string; created: number; votes: number };

/** Suggestions created per day and votes cast per day, zero-filled over the window.
 *  suggestion_votes has no guildId of its own, so votes are scoped via a join through
 *  suggestions.guildId. */
export async function getFilledSuggestionDaily(guildId: string, days: number = 14): Promise<SuggestionDailyRow[]> {
  const db = getDb();
  const since = sinceBoundary(days);

  const createdFilters = [eq(suggestions.guildId, guildId)];
  if (since) createdFilters.push(gte(suggestions.createdAt, since));
  const createdRows = await db
    .select({
      statDate: sql<string>`date(${suggestions.createdAt}, 'unixepoch')`,
      count: sql<number>`count(*)`,
    })
    .from(suggestions)
    .where(and(...createdFilters))
    .groupBy(sql`date(${suggestions.createdAt}, 'unixepoch')`);

  const voteFilters = [eq(suggestions.guildId, guildId)];
  if (since) voteFilters.push(gte(suggestionVotes.createdAt, since));
  const voteRows = await db
    .select({
      statDate: sql<string>`date(${suggestionVotes.createdAt}, 'unixepoch')`,
      count: sql<number>`count(*)`,
    })
    .from(suggestionVotes)
    .innerJoin(suggestions, eq(suggestionVotes.suggestionId, suggestions.id))
    .where(and(...voteFilters))
    .groupBy(sql`date(${suggestionVotes.createdAt}, 'unixepoch')`);

  const createdMap = new Map(createdRows.map((row) => [row.statDate, row.count]));
  const voteMap = new Map(voteRows.map((row) => [row.statDate, row.count]));

  const dates = isAllTimeWindow(days)
    ? resolveFilledWindow(days, [...createdMap.keys(), ...voteMap.keys()])
    : dateRange(days);

  return dates.map((date) => ({
    statDate: date,
    created: createdMap.get(date) ?? 0,
    votes: voteMap.get(date) ?? 0,
  }));
}

export type ReviewDailyRow = { statDate: string; count: number; avgRating: number | null };

/** Reviews created per day and their average rating per day, zero-filled over the window.
 *  avgRating is null (not 0) for a day with no reviews, to avoid implying a zero-star average. */
export async function getFilledReviewDaily(guildId: string, days: number = 14): Promise<ReviewDailyRow[]> {
  const db = getDb();
  const since = sinceBoundary(days);

  const filters = [eq(reviews.guildId, guildId)];
  if (since) filters.push(gte(reviews.createdAt, since));
  const rows = await db
    .select({
      statDate: sql<string>`date(${reviews.createdAt}, 'unixepoch')`,
      count: sql<number>`count(*)`,
      avgRating: sql<number>`avg(${reviews.rating})`,
    })
    .from(reviews)
    .where(and(...filters))
    .groupBy(sql`date(${reviews.createdAt}, 'unixepoch')`);

  const byDate = new Map(rows.map((row) => [row.statDate, row]));
  const dates = isAllTimeWindow(days) ? resolveFilledWindow(days, rows.map((row) => row.statDate)) : dateRange(days);

  return dates.map((date) => {
    const row = byDate.get(date);
    return {
      statDate: date,
      count: row?.count ?? 0,
      avgRating: row && row.count > 0 ? Number(row.avgRating.toFixed(2)) : null,
    };
  });
}
