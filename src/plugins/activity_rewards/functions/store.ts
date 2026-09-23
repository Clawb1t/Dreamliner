import { and, count, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import {
  activityRewardsAwarded,
  activityRewardsProgress,
  guildStatsUserDaily,
  guildStatsUserVoiceDaily,
} from "../../../db/schema.js";
import type { ActivityProgress } from "./config.js";

const EMPTY: ActivityProgress = { messages: 0, voiceSeconds: 0 };

export function getProgress(guildId: string, userId: string): ActivityProgress {
  const row = getDb()
    .select({ messages: activityRewardsProgress.messages, voiceSeconds: activityRewardsProgress.voiceSeconds })
    .from(activityRewardsProgress)
    .where(and(eq(activityRewardsProgress.guildId, guildId), eq(activityRewardsProgress.userId, userId)))
    .get();
  return row ?? { ...EMPTY };
}

/** Adds to a member's totals (negative deltas allowed, floored at 0) and returns the new totals. */
export function addProgress(
  guildId: string,
  userId: string,
  delta: { messages?: number; voiceSeconds?: number },
): ActivityProgress {
  const messages = Math.trunc(delta.messages ?? 0);
  const voiceSeconds = Math.trunc(delta.voiceSeconds ?? 0);
  const row = getDb()
    .insert(activityRewardsProgress)
    .values({
      guildId,
      userId,
      messages: Math.max(0, messages),
      voiceSeconds: Math.max(0, voiceSeconds),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [activityRewardsProgress.guildId, activityRewardsProgress.userId],
      set: {
        messages: sql`MAX(0, ${activityRewardsProgress.messages} + ${messages})`,
        voiceSeconds: sql`MAX(0, ${activityRewardsProgress.voiceSeconds} + ${voiceSeconds})`,
        updatedAt: new Date(),
      },
    })
    .returning({ messages: activityRewardsProgress.messages, voiceSeconds: activityRewardsProgress.voiceSeconds })
    .get();
  return row ?? { ...EMPTY };
}

export function listAwarded(guildId: string, userId: string): Set<number> {
  const rows = getDb()
    .select({ id: activityRewardsAwarded.milestoneId })
    .from(activityRewardsAwarded)
    .where(and(eq(activityRewardsAwarded.guildId, guildId), eq(activityRewardsAwarded.userId, userId)))
    .all();
  return new Set(rows.map((r) => r.id));
}

export function markAwarded(guildId: string, userId: string, milestoneIds: number[]): void {
  if (milestoneIds.length === 0) return;
  const awardedAt = new Date();
  getDb()
    .insert(activityRewardsAwarded)
    .values(milestoneIds.map((milestoneId) => ({ guildId, userId, milestoneId, awardedAt })))
    .onConflictDoNothing()
    .run();
}

/** Wipes a member's progress and award history. */
export function resetMember(guildId: string, userId: string): void {
  const db = getDb();
  db.delete(activityRewardsProgress)
    .where(and(eq(activityRewardsProgress.guildId, guildId), eq(activityRewardsProgress.userId, userId)))
    .run();
  db.delete(activityRewardsAwarded)
    .where(and(eq(activityRewardsAwarded.guildId, guildId), eq(activityRewardsAwarded.userId, userId)))
    .run();
}

export type ActivityLeaderboardRow = ActivityProgress & { userId: string };

export function topMembers(
  guildId: string,
  metric: "messages" | "voice_minutes",
  limit = 10,
): ActivityLeaderboardRow[] {
  const column = metric === "messages" ? activityRewardsProgress.messages : activityRewardsProgress.voiceSeconds;
  return getDb()
    .select({
      userId: activityRewardsProgress.userId,
      messages: activityRewardsProgress.messages,
      voiceSeconds: activityRewardsProgress.voiceSeconds,
    })
    .from(activityRewardsProgress)
    .where(and(eq(activityRewardsProgress.guildId, guildId), sql`${column} > 0`))
    .orderBy(desc(column))
    .limit(limit)
    .all();
}

/** 1-based rank on a track, or null when the member has no progress on it. */
export function memberRank(guildId: string, value: number, metric: "messages" | "voice_minutes"): number | null {
  if (value <= 0) return null;
  const column = metric === "messages" ? activityRewardsProgress.messages : activityRewardsProgress.voiceSeconds;
  const row = getDb()
    .select({ n: count() })
    .from(activityRewardsProgress)
    .where(and(eq(activityRewardsProgress.guildId, guildId), sql`${column} > ${value}`))
    .get();
  return (row?.n ?? 0) + 1;
}

export function guildTotals(guildId: string): { members: number; awarded: number } {
  const db = getDb();
  const members =
    db
      .select({ n: count() })
      .from(activityRewardsProgress)
      .where(eq(activityRewardsProgress.guildId, guildId))
      .get()?.n ?? 0;
  const awarded =
    db
      .select({ n: count() })
      .from(activityRewardsAwarded)
      .where(eq(activityRewardsAwarded.guildId, guildId))
      .get()?.n ?? 0;
  return { members, awarded };
}

export function awardedCounts(guildId: string, userIds: string[]): Map<string, number> {
  if (userIds.length === 0) return new Map();
  const rows = getDb()
    .select({ userId: activityRewardsAwarded.userId, n: count() })
    .from(activityRewardsAwarded)
    .where(
      and(
        eq(activityRewardsAwarded.guildId, guildId),
        sql`${activityRewardsAwarded.userId} IN (${sql.join(
          userIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
    )
    .groupBy(activityRewardsAwarded.userId)
    .all();
  return new Map(rows.map((r) => [r.userId, r.n]));
}

/**
 * One-off backfill from the Stats plugin's per-member history: raises each member's progress to
 * at least their recorded all-time messages / voice seconds (never lowers it, so running it twice
 * or after tracking has started is safe). Returns how many members were touched.
 */
export function importFromStats(guildId: string): number {
  const db = getDb();
  const messageRows = db
    .select({ userId: guildStatsUserDaily.userId, total: sql<number>`SUM(${guildStatsUserDaily.messages})` })
    .from(guildStatsUserDaily)
    .where(eq(guildStatsUserDaily.guildId, guildId))
    .groupBy(guildStatsUserDaily.userId)
    .all();
  const voiceRows = db
    .select({
      userId: guildStatsUserVoiceDaily.userId,
      total: sql<number>`SUM(MAX(${guildStatsUserVoiceDaily.seconds}, ${guildStatsUserVoiceDaily.minutes} * 60))`,
    })
    .from(guildStatsUserVoiceDaily)
    .where(eq(guildStatsUserVoiceDaily.guildId, guildId))
    .groupBy(guildStatsUserVoiceDaily.userId)
    .all();

  const merged = new Map<string, ActivityProgress>();
  for (const row of messageRows) {
    merged.set(row.userId, { messages: Number(row.total) || 0, voiceSeconds: 0 });
  }
  for (const row of voiceRows) {
    const entry = merged.get(row.userId) ?? { messages: 0, voiceSeconds: 0 };
    entry.voiceSeconds = Number(row.total) || 0;
    merged.set(row.userId, entry);
  }

  const updatedAt = new Date();
  db.transaction((tx) => {
    for (const [userId, totals] of merged) {
      tx.insert(activityRewardsProgress)
        .values({ guildId, userId, messages: totals.messages, voiceSeconds: totals.voiceSeconds, updatedAt })
        .onConflictDoUpdate({
          target: [activityRewardsProgress.guildId, activityRewardsProgress.userId],
          set: {
            messages: sql`MAX(${activityRewardsProgress.messages}, ${totals.messages})`,
            voiceSeconds: sql`MAX(${activityRewardsProgress.voiceSeconds}, ${totals.voiceSeconds})`,
            updatedAt,
          },
        })
        .run();
    }
  });
  return merged.size;
}
