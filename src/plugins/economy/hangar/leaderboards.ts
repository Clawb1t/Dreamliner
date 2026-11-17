import { and, desc, gt, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { planeCardFlights, planeCardUserState } from "../../../db/schema.js";
import { LEADERBOARD_MAX, type LeaderboardBoard } from "./constants.js";

export type LeaderboardEntry = { rank: number; userId: string; value: number; rarestCopyId?: number | null };

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * One leaderboard. `memberIds` limits it to a set of users (a server's members) and is applied in
 * SQL, so a per-server board never includes anyone outside that server.
 */
export function leaderboard(board: LeaderboardBoard, opts: { limit?: number; memberIds?: string[] | null; at?: Date } = {}): LeaderboardEntry[] {
  const limit = Math.max(1, Math.min(LEADERBOARD_MAX, opts.limit ?? 25));
  if (opts.memberIds && opts.memberIds.length === 0) return [];
  const db = getDb();
  if (board === "flights_weekly") {
    const since = new Date((opts.at ?? new Date()).getTime() - WEEK_MS);
    const conditions = [gte(planeCardFlights.claimedAt, since)];
    if (opts.memberIds) conditions.push(inArray(planeCardFlights.userId, opts.memberIds));
    const rows = db
      .select({ userId: planeCardFlights.userId, value: sql<number>`COUNT(*)` })
      .from(planeCardFlights)
      .where(and(...conditions))
      .groupBy(planeCardFlights.userId)
      .orderBy(desc(sql`COUNT(*)`), planeCardFlights.userId)
      .limit(limit)
      .all();
    return rows.map((r, i) => ({ rank: i + 1, userId: r.userId, value: Number(r.value) }));
  }
  const column =
    board === "rarest" ? planeCardUserState.rarestPoints : board === "sets" ? planeCardUserState.setsCompleted : planeCardUserState.fleetValue;
  const conditions = [gt(column, 0)];
  if (opts.memberIds) conditions.push(inArray(planeCardUserState.userId, opts.memberIds));
  const rows = db
    .select({ userId: planeCardUserState.userId, value: column, rarestCopyId: planeCardUserState.rarestCopyId, fleet: planeCardUserState.fleetValue })
    .from(planeCardUserState)
    .where(and(...conditions))
    .orderBy(desc(column), desc(planeCardUserState.fleetValue), planeCardUserState.userId)
    .limit(limit)
    .all();
  return rows.map((r, i) => ({
    rank: i + 1,
    userId: r.userId,
    value: Number(r.value),
    ...(board === "rarest" ? { rarestCopyId: r.rarestCopyId } : {}),
  }));
}

/** Every user with a non-zero Fleet Value (candidates for a per-server board). */
export function rankedUserIds(limit = 20_000): string[] {
  return getDb()
    .select({ userId: planeCardUserState.userId })
    .from(planeCardUserState)
    .where(gt(planeCardUserState.copiesCount, 0))
    .limit(limit)
    .all()
    .map((r) => r.userId);
}

/** A user's global position on the Fleet Value board (1-based), or null without a score. */
export function globalFleetRank(userId: string): number | null {
  const row = getDb().get<{ fleet: number | null; position: number | null }>(sql`
    SELECT s.fleet_value AS fleet,
      (SELECT COUNT(*) FROM plane_card_user_state o WHERE o.fleet_value > s.fleet_value) + 1 AS position
    FROM plane_card_user_state s WHERE s.user_id = ${userId}`);
  if (!row || !row.fleet) return null;
  return Number(row.position);
}
