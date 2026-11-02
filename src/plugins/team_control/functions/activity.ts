import { sql } from "drizzle-orm";
import type { TeamControlConfig } from "../../../config/schemas/teamControl.js";
import { getDb } from "../../../db/client.js";
import { rankIndexById } from "./authority.js";
import { isExcusedFromPeriod } from "./leaveRules.js";
import { dayKey, daysIn, type PeriodRange } from "./periods.js";
import { computePoints, EMPTY_METRICS, evaluateQuota, type QuotaState, type TeamMetrics } from "./quota.js";
import { shiftSecondsInRange } from "./shiftMath.js";
import { leaveOverlapping, shiftsOverlapping } from "./store.js";

/** mod_cases and tickets store seconds; team tables store milliseconds. */
const secs = (date: Date) => Math.floor(date.getTime() / 1000);

function idList(ids: string[]) {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

/**
 * Every metric for a set of members over [from, to): shift minutes (breaks excluded), moderation
 * cases they opened, tickets they closed, staff-channel messages and voice minutes.
 */
export function computeMetrics(guildId: string, userIds: string[], from: Date, to: Date, now = Date.now()): Map<string, TeamMetrics> {
  const out = new Map<string, TeamMetrics>();
  for (const id of userIds) out.set(id, { ...EMPTY_METRICS });
  if (userIds.length === 0) return out;
  const db = getDb();
  const ids = idList(userIds);
  const fromDay = dayKey(from.getTime());
  const toDay = dayKey(to.getTime());

  for (const shift of shiftsOverlapping(guildId, from, to, userIds)) {
    const m = out.get(shift.userId);
    if (m) m.shiftMinutes += shiftSecondsInRange(shift, from.getTime(), to.getTime(), now) / 60;
  }
  const mod = db.all<{ id: string; n: number }>(sql`
    SELECT mod_id AS id, COUNT(*) AS n FROM mod_cases
    WHERE guild_id = ${guildId} AND mod_id IN (${ids}) AND created_at >= ${secs(from)} AND created_at < ${secs(to)}
    GROUP BY mod_id
  `);
  for (const row of mod) out.get(row.id)!.modActions = Number(row.n);
  const tickets = db.all<{ id: string; n: number }>(sql`
    SELECT closed_by AS id, COUNT(*) AS n FROM tickets
    WHERE guild_id = ${guildId} AND closed_by IN (${ids}) AND closed_at >= ${secs(from)} AND closed_at < ${secs(to)}
    GROUP BY closed_by
  `);
  for (const row of tickets) out.get(row.id)!.ticketsClosed = Number(row.n);
  const messages = db.all<{ id: string; n: number }>(sql`
    SELECT user_id AS id, SUM(staff_messages) AS n FROM team_activity_daily
    WHERE guild_id = ${guildId} AND user_id IN (${ids}) AND day >= ${fromDay} AND day < ${toDay}
    GROUP BY user_id
  `);
  for (const row of messages) out.get(row.id)!.staffMessages = Number(row.n) || 0;
  const voice = db.all<{ id: string; n: number }>(sql`
    SELECT user_id AS id, SUM(minutes) AS n FROM guild_stats_user_voice_daily
    WHERE guild_id = ${guildId} AND user_id IN (${ids}) AND stat_date >= ${fromDay} AND stat_date < ${toDay}
    GROUP BY user_id
  `);
  for (const row of voice) out.get(row.id)!.voiceMinutes = Number(row.n) || 0;
  for (const m of out.values()) m.shiftMinutes = Math.round(m.shiftMinutes);
  return out;
}

export type DailyActivity = { day: string; shiftMinutes: number; modActions: number; ticketsClosed: number; staffMessages: number };

/** Team totals per UTC day across [from, to) (shifts split across the days they ran). */
export function computeDaily(guildId: string, userIds: string[], from: Date, to: Date, now = Date.now()): DailyActivity[] {
  const days = daysIn(from.getTime(), Math.min(to.getTime(), now + 1));
  const byDay = new Map(days.map((day) => [day, { day, shiftMinutes: 0, modActions: 0, ticketsClosed: 0, staffMessages: 0 }]));
  if (userIds.length === 0 || days.length === 0) return [...byDay.values()];
  const db = getDb();
  const ids = idList(userIds);
  const shifts = shiftsOverlapping(guildId, from, to, userIds);
  for (const day of days) {
    const start = Date.parse(`${day}T00:00:00Z`);
    const entry = byDay.get(day)!;
    for (const shift of shifts) entry.shiftMinutes += shiftSecondsInRange(shift, start, start + 86_400_000, now) / 60;
    entry.shiftMinutes = Math.round(entry.shiftMinutes);
  }
  const fill = (rows: Array<{ day: string; n: number }>, key: "modActions" | "ticketsClosed" | "staffMessages") => {
    for (const row of rows) {
      const entry = byDay.get(row.day);
      if (entry) entry[key] = Number(row.n) || 0;
    }
  };
  fill(
    db.all(sql`
      SELECT strftime('%Y-%m-%d', created_at, 'unixepoch') AS day, COUNT(*) AS n FROM mod_cases
      WHERE guild_id = ${guildId} AND mod_id IN (${ids}) AND created_at >= ${secs(from)} AND created_at < ${secs(to)}
      GROUP BY day
    `),
    "modActions",
  );
  fill(
    db.all(sql`
      SELECT strftime('%Y-%m-%d', closed_at, 'unixepoch') AS day, COUNT(*) AS n FROM tickets
      WHERE guild_id = ${guildId} AND closed_by IN (${ids}) AND closed_at >= ${secs(from)} AND closed_at < ${secs(to)}
      GROUP BY day
    `),
    "ticketsClosed",
  );
  fill(
    db.all(sql`
      SELECT day, SUM(staff_messages) AS n FROM team_activity_daily
      WHERE guild_id = ${guildId} AND user_id IN (${ids}) AND day >= ${dayKey(from.getTime())} AND day < ${dayKey(to.getTime())}
      GROUP BY day
    `),
    "staffMessages",
  );
  return [...byDay.values()];
}

/** Shift minutes per day for one member over the last `days` days (profile chart). */
export function shiftDaily(guildId: string, userId: string, days = 30, now = Date.now()): Array<{ day: string; minutes: number }> {
  const end = Date.parse(`${dayKey(now)}T00:00:00Z`) + 86_400_000;
  const start = end - days * 86_400_000;
  const shifts = shiftsOverlapping(guildId, new Date(start), new Date(end), [userId]);
  return daysIn(start, end).map((day) => {
    const s = Date.parse(`${day}T00:00:00Z`);
    const seconds = shifts.reduce((sum, shift) => sum + shiftSecondsInRange(shift, s, s + 86_400_000, now), 0);
    return { day, minutes: Math.round(seconds / 60) };
  });
}

export type MemberQuota = { metrics: TeamMetrics; quota: QuotaState };

/**
 * Metrics plus quota state for each member at their rank. Points are filled in points mode only.
 * `rankIds` maps user → rank id (null = no rank, nothing required).
 */
export function evaluateTeam(
  guildId: string,
  config: TeamControlConfig,
  rankIds: Map<string, string | null>,
  range: PeriodRange,
  now = Date.now(),
): Map<string, MemberQuota> {
  const userIds = [...rankIds.keys()];
  const metrics = computeMetrics(guildId, userIds, range.start, range.end, now);
  const leave = config.leave.exempt_from_quota ? leaveOverlapping(guildId, range.start, range.end) : [];
  const leaveByUser = new Map<string, typeof leave>();
  for (const row of leave) leaveByUser.set(row.userId, [...(leaveByUser.get(row.userId) ?? []), row]);
  const pointsMode = config.activity.points_mode;
  const out = new Map<string, MemberQuota>();
  for (const userId of userIds) {
    const m = metrics.get(userId)!;
    if (pointsMode) m.points = computePoints(m, config.activity.weights);
    const rank = config.ranks[rankIndexById(config.ranks, rankIds.get(userId))] ?? null;
    const excused = isExcusedFromPeriod(leaveByUser.get(userId) ?? [], range.start.getTime(), range.end.getTime());
    out.set(userId, {
      metrics: m,
      quota: evaluateQuota(rank?.quota ?? null, m, {
        pointsMode,
        pointsQuota: rank?.points_quota ?? 0,
        excused,
        countsMessages: config.activity.staff_channel_ids.length > 0,
      }),
    });
  }
  return out;
}

/** Latest activity per member (shift, mod case, closed ticket or staff message), in ms. */
export function lastActivity(guildId: string, userIds: string[], lastShift: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  if (userIds.length === 0) return out;
  const db = getDb();
  const ids = idList(userIds);
  const bump = (id: string, ms: number) => {
    if (Number.isFinite(ms) && ms > (out.get(id) ?? 0)) out.set(id, ms);
  };
  for (const id of userIds) bump(id, lastShift.get(id) ?? 0);
  for (const row of db.all<{ id: string; at: number }>(sql`
    SELECT mod_id AS id, MAX(created_at) AS at FROM mod_cases WHERE guild_id = ${guildId} AND mod_id IN (${ids}) GROUP BY mod_id
  `)) {
    bump(row.id, Number(row.at) * 1000);
  }
  for (const row of db.all<{ id: string; at: number }>(sql`
    SELECT closed_by AS id, MAX(closed_at) AS at FROM tickets WHERE guild_id = ${guildId} AND closed_by IN (${ids}) GROUP BY closed_by
  `)) {
    bump(row.id, Number(row.at) * 1000);
  }
  for (const row of db.all<{ id: string; day: string }>(sql`
    SELECT user_id AS id, MAX(day) AS day FROM team_activity_daily WHERE guild_id = ${guildId} AND user_id IN (${ids}) GROUP BY user_id
  `)) {
    // A staff message day counts as activity at the end of that day.
    bump(row.id, Date.parse(`${row.day}T23:59:59Z`));
  }
  return out;
}
