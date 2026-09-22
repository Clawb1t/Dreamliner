import { and, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { guildLogEvents, guildStatsUserDaily } from "../../../db/schema.js";
import { configManager } from "../../../config/manager.js";
import { pluginEnabled } from "../../../core/pluginCommand.js";
import { dateRange, dateRangeInclusive, isAllTimeWindow } from "./daily.js";

/** Matches guild_log_events' own retention window (RETENTION_MS in src/core/logging/store.ts, and
 *  the same private copy retention.ts keeps) — join events older than this are pruned, so a cohort
 *  can't extend further back than it. */
const LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** How many days after joining count as "engaged" if the member posted at least once. */
const ENGAGEMENT_WINDOW_DAYS = 7;

export type NewMemberEngagement = {
  cohortSize: number;
  engagedCount: number;
  engagedPct: number;
  baselineCohortSize: number;
  baselineEngagedPct: number;
  /** Percentage-point shift (not relative %) — an engagement-RATE comparison, not a volume one. */
  deltaPct: number;
};

type Joiner = { userId: string; joinedAt: number };

function engagedPct(joiners: Joiner[], activeDatesByUser: Map<string, Set<string>>): number {
  if (joiners.length === 0) return 0;
  let engaged = 0;
  for (const joiner of joiners) {
    const from = new Date(joiner.joinedAt).toISOString().slice(0, 10);
    const to = new Date(joiner.joinedAt + ENGAGEMENT_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    const activeDates = activeDatesByUser.get(joiner.userId);
    if (activeDates && dateRangeInclusive(from, to).some((date) => activeDates.has(date))) engaged += 1;
  }
  return (engaged / joiners.length) * 100;
}

/**
 * What share of members who joined in the current window posted at least once within their first
 * 7 days, vs. the same rate for a trailing baseline cohort — "are new members engaging more or
 * less than usual". Requires the `logs` plugin (member_join events are only recorded there); returns
 * null if it's disabled or there's no join history in the retained window. Only ever reports
 * aggregate cohort counts/percentages, mirroring getRetentionCohorts' own privacy stance — never
 * which specific member did or didn't engage.
 */
export async function getNewMemberEngagementRate(guildId: string, days: number): Promise<NewMemberEngagement | null> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  if (!pluginEnabled(guildConfig, "logs")) return null;

  const compareWindowDays = isAllTimeWindow(days) ? 30 : days;
  const baselineHorizonDays = Math.max(28, compareWindowDays * 4);
  const cutoff = new Date(Date.now() - LOG_RETENTION_MS);
  const currentSinceDate = dateRange(compareWindowDays)[0]!;
  const currentSinceMs = Date.parse(`${currentSinceDate}T00:00:00.000Z`);
  const lookbackSinceDate = dateRange(compareWindowDays + baselineHorizonDays)[0]!;
  const lookbackSince = new Date(Math.max(cutoff.getTime(), Date.parse(`${lookbackSinceDate}T00:00:00.000Z`)));

  const db = getDb();
  const joinRows = await db
    .select({ targetId: guildLogEvents.targetId, createdAt: guildLogEvents.createdAt })
    .from(guildLogEvents)
    .where(
      and(
        eq(guildLogEvents.guildId, guildId),
        eq(guildLogEvents.eventType, "member_join"),
        gte(guildLogEvents.createdAt, lookbackSince),
      ),
    );

  if (joinRows.length === 0) return null;

  const currentJoiners: Joiner[] = [];
  const baselineJoiners: Joiner[] = [];
  for (const row of joinRows) {
    if (!row.targetId) continue;
    const t = row.createdAt.getTime();
    (t >= currentSinceMs ? currentJoiners : baselineJoiners).push({ userId: row.targetId, joinedAt: t });
  }
  if (currentJoiners.length === 0) return null;

  const allJoinerIds = [...new Set([...currentJoiners, ...baselineJoiners].map((j) => j.userId))];
  const userDailyRows = await db
    .select({ userId: guildStatsUserDaily.userId, statDate: guildStatsUserDaily.statDate })
    .from(guildStatsUserDaily)
    .where(and(eq(guildStatsUserDaily.guildId, guildId), inArray(guildStatsUserDaily.userId, allJoinerIds)));

  const activeDatesByUser = new Map<string, Set<string>>();
  for (const row of userDailyRows) {
    const set = activeDatesByUser.get(row.userId) ?? new Set<string>();
    set.add(row.statDate);
    activeDatesByUser.set(row.userId, set);
  }

  const currentEngagedPct = engagedPct(currentJoiners, activeDatesByUser);
  const baselineEngagedPct = engagedPct(baselineJoiners, activeDatesByUser);

  return {
    cohortSize: currentJoiners.length,
    engagedCount: Math.round((currentEngagedPct / 100) * currentJoiners.length),
    engagedPct: Number(currentEngagedPct.toFixed(1)),
    baselineCohortSize: baselineJoiners.length,
    baselineEngagedPct: Number(baselineEngagedPct.toFixed(1)),
    deltaPct: Number((currentEngagedPct - baselineEngagedPct).toFixed(1)),
  };
}
