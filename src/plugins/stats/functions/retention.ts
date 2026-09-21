import { and, asc, eq, gte } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { guildLogEvents } from "../../../db/schema.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";

/** Matches guild_log_events' own retention window (RETENTION_MS in src/core/logging/store.ts);
 *  join/leave events older than this are pruned, so cohorts can't extend further back than it. */
const LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const RETENTION_HORIZONS_DAYS = [7, 14, 30] as const;

export type RetentionCohort = {
  cohortStart: string;
  cohortSize: number;
  retainedAt: { days: number; pct: number | null }[];
};

/**
 * Buckets member_join events into `cohortDays`-wide cohorts within the retained
 * guild_log_events window, and for each cohort reports what percentage of the members who
 * joined in it are still known to be in the server (no later member_leave event) at each of
 * 7/14/30 days after they joined. A horizon is omitted (null) for a cohort where not enough
 * time has elapsed yet for every member in it to have reached that horizon. Only ever returns
 * aggregate counts/percentages, never which specific members left.
 */
export async function getRetentionCohorts(guildId: string, cohortDays: number = 7): Promise<RetentionCohort[]> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  if (!pluginEnabled(guildConfig, "logs")) return [];

  const db = getDb();
  const cutoff = new Date(Date.now() - LOG_RETENTION_MS);

  const [joinRows, leaveRows] = await Promise.all([
    db
      .select({ targetId: guildLogEvents.targetId, createdAt: guildLogEvents.createdAt })
      .from(guildLogEvents)
      .where(
        and(
          eq(guildLogEvents.guildId, guildId),
          eq(guildLogEvents.eventType, "member_join"),
          gte(guildLogEvents.createdAt, cutoff),
        ),
      )
      .orderBy(asc(guildLogEvents.createdAt)),
    db
      .select({ targetId: guildLogEvents.targetId, createdAt: guildLogEvents.createdAt })
      .from(guildLogEvents)
      .where(
        and(
          eq(guildLogEvents.guildId, guildId),
          eq(guildLogEvents.eventType, "member_leave"),
          gte(guildLogEvents.createdAt, cutoff),
        ),
      )
      .orderBy(asc(guildLogEvents.createdAt)),
  ]);

  if (joinRows.length === 0) return [];

  const leavesByUser = new Map<string, number[]>();
  for (const row of leaveRows) {
    if (!row.targetId) continue;
    const arr = leavesByUser.get(row.targetId) ?? [];
    arr.push(row.createdAt.getTime());
    leavesByUser.set(row.targetId, arr);
  }
  for (const arr of leavesByUser.values()) arr.sort((a, b) => a - b);

  const safeCohortDays = Math.max(1, Math.floor(cohortDays));
  const cohortMs = safeCohortDays * 86_400_000;
  const now = Date.now();
  const today = new Date();
  const todayUtcStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  const earliestJoinMs = joinRows[0]!.createdAt.getTime();
  const windowStartMs = Math.max(cutoff.getTime(), earliestJoinMs);
  const cohortCount = Math.max(1, Math.ceil((todayUtcStart - windowStartMs) / cohortMs) + 1);

  const cohorts: RetentionCohort[] = [];

  for (let i = 0; i < cohortCount; i++) {
    const cohortStartMs = todayUtcStart - (cohortCount - i) * cohortMs;
    const cohortEndMs = cohortStartMs + cohortMs;

    const joinTimeByUser = new Map<string, number>();
    for (const row of joinRows) {
      if (!row.targetId) continue;
      const t = row.createdAt.getTime();
      if (t < cohortStartMs || t >= cohortEndMs) continue;
      // A user who joined more than once inside this cohort is credited with their earliest join.
      const existing = joinTimeByUser.get(row.targetId);
      if (existing === undefined || t < existing) joinTimeByUser.set(row.targetId, t);
    }

    if (joinTimeByUser.size === 0) continue;

    const retainedAt = RETENTION_HORIZONS_DAYS.map((days) => {
      const horizonMs = days * 86_400_000;
      // Only report once every member of this cohort could possibly have reached the horizon,
      // a cohort that started 5 days ago can't yet have a meaningful "30 days later" figure.
      if (now - cohortEndMs < horizonMs) return { days, pct: null };

      let retained = 0;
      for (const [userId, joinTime] of joinTimeByUser) {
        const leftWithinHorizon = (leavesByUser.get(userId) ?? []).some(
          (leaveTime) => leaveTime > joinTime && leaveTime <= joinTime + horizonMs,
        );
        if (!leftWithinHorizon) retained += 1;
      }
      return { days, pct: Number(((retained / joinTimeByUser.size) * 100).toFixed(1)) };
    });

    cohorts.push({
      cohortStart: new Date(cohortStartMs).toISOString().slice(0, 10),
      cohortSize: joinTimeByUser.size,
      retainedAt,
    });
  }

  return cohorts;
}
