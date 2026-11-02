import type { TeamControlConfig } from "../../../config/schemas/teamControl.js";
import { evaluateTeam } from "./activity.js";
import { rankIndexById } from "./authority.js";
import type { MemberStatus, TeamStatus } from "./config.js";
import { historyCutoff } from "./oneGate.js";
import type { PeriodRange } from "./periods.js";
import type { QuotaState, TeamMetrics } from "./quota.js";
import { computeStatuses } from "./roster.js";
import { countActiveStrikes } from "./strikes.js";
import { feedbackAverages, getTeamMember, listCurrentTeam, strikeRows, type TeamMemberRecord } from "./store.js";

/** Everything the roster, reports and dashboard show for one team member in one period. */
export type TeamMemberSummary = {
  userId: string;
  rankId: string | null;
  rankName: string | null;
  rankIndex: number;
  status: TeamStatus;
  memberStatus: MemberStatus;
  joinedAt: Date;
  trialEndsAt: Date | null;
  activeStrikes: number;
  feedbackAvg: number | null;
  metrics: TeamMetrics;
  quota: QuotaState;
};

/** Summaries for the given rows (default: the whole current team), sorted rank high to low. */
export function summarizeTeam(
  guildId: string,
  config: TeamControlConfig,
  range: PeriodRange,
  one: boolean,
  rows: TeamMemberRecord[] = listCurrentTeam(guildId),
  now = Date.now(),
): TeamMemberSummary[] {
  if (rows.length === 0) return [];
  const ranks = new Map(rows.map((row) => [row.userId, row.rankId]));
  const evaluated = evaluateTeam(guildId, config, ranks, range, now);
  const statuses = computeStatuses(guildId);
  const strikes = strikeRows(guildId, rows.map((row) => row.userId));
  const strikesByUser = new Map<string, typeof strikes>();
  for (const s of strikes) strikesByUser.set(s.userId, [...(strikesByUser.get(s.userId) ?? []), s]);
  const feedback = feedbackAverages(guildId, historyCutoff(one, now));
  return rows
    .map((row) => {
      const rankIndex = rankIndexById(config.ranks, row.rankId);
      const rank = config.ranks[rankIndex] ?? null;
      const result = evaluated.get(row.userId)!;
      return {
        userId: row.userId,
        rankId: rank?.id ?? null,
        rankName: rank?.name ?? null,
        rankIndex,
        status: statuses.get(row.userId) ?? (row.status === "suspended" ? "suspended" : "off_duty"),
        memberStatus: row.status as MemberStatus,
        joinedAt: row.joinedAt,
        trialEndsAt: row.trialEndsAt,
        activeStrikes: countActiveStrikes(strikesByUser.get(row.userId) ?? [], now),
        feedbackAvg: feedback.get(row.userId) ?? null,
        metrics: result.metrics,
        quota: result.quota,
      } satisfies TeamMemberSummary;
    })
    .sort((a, b) => b.rankIndex - a.rankIndex);
}

/** One member's summary (also for former staff, who keep their last rank). */
export function summarizeMember(guildId: string, config: TeamControlConfig, range: PeriodRange, one: boolean, userId: string): TeamMemberSummary | null {
  const row = getTeamMember(guildId, userId);
  if (!row) return null;
  return summarizeTeam(guildId, config, range, one, [row])[0] ?? null;
}
