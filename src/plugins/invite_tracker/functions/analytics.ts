import { sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { JOIN_SOURCES, type JoinSource } from "./config.js";
import { listTrackedLinks, trackedLinkStats, withTotal, type InviterCounts } from "./store.js";

export const ANALYTICS_RANGES = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 } as const;
export type AnalyticsRange = keyof typeof ANALYTICS_RANGES;

export type AnalyticsDay = { day: string } & Record<JoinSource, number> & { leaves: number; fakes: number };

export type InviteAnalytics = {
  range: AnalyticsRange;
  days: AnalyticsDay[];
  sources: Record<JoinSource, number>;
  retention: { d1: number | null; d7: number | null; d30: number | null };
  topInviters: InviterCounts[];
  links: Array<{ id: number; name: string; joins: number; stayed: number; left: number; fake: number }>;
};

const DAY_MS = 86_400_000;

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function emptyDay(day: string): AnalyticsDay {
  return { day, invite: 0, tracked: 0, vanity: 0, oauth: 0, unknown: 0, leaves: 0, fakes: 0 };
}

function asSource(value: string): JoinSource {
  return (JOIN_SOURCES as string[]).includes(value) ? (value as JoinSource) : "unknown";
}

/** UTC day keys from `days - 1` days ago through today. */
export function dayRange(days: number, now = Date.now()): string[] {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return Array.from({ length: days }, (_, i) => dayKey(today - (days - 1 - i) * DAY_MS));
}

/**
 * Joins by source, leaves and fakes per day, from the raw rows plus anything retention has folded
 * into daily totals (folded leaves land on their join day; live ones on the day they left).
 */
export function dailySeries(guildId: string, days: number, now = Date.now()): AnalyticsDay[] {
  const keys = dayRange(days, now);
  const sinceMs = Date.parse(`${keys[0]}T00:00:00.000Z`);
  const byDay = new Map(keys.map((key) => [key, emptyDay(key)]));
  const db = getDb();

  const joins = db.all<{ day: string; source: string; joins: number; fakes: number }>(sql`
    SELECT strftime('%Y-%m-%d', joined_at / 1000, 'unixepoch') AS day, source, COUNT(*) AS joins,
      SUM(CASE WHEN status = 'fake' THEN 1 ELSE 0 END) AS fakes
    FROM invite_joins WHERE guild_id = ${guildId} AND joined_at >= ${sinceMs}
    GROUP BY day, source
  `);
  for (const row of joins) {
    const entry = byDay.get(row.day);
    if (!entry) continue;
    entry[asSource(row.source)] += Number(row.joins) || 0;
    entry.fakes += Number(row.fakes) || 0;
  }

  const leaves = db.all<{ day: string; leaves: number }>(sql`
    SELECT strftime('%Y-%m-%d', left_at / 1000, 'unixepoch') AS day, COUNT(*) AS leaves
    FROM invite_joins WHERE guild_id = ${guildId} AND left_at IS NOT NULL AND left_at >= ${sinceMs}
    GROUP BY day
  `);
  for (const row of leaves) {
    const entry = byDay.get(row.day);
    if (entry) entry.leaves += Number(row.leaves) || 0;
  }

  const folded = db.all<{ day: string; source: string; joins: number; leaves: number; fakes: number }>(sql`
    SELECT day, source, SUM(joins) AS joins, SUM(leaves) AS leaves, SUM(fakes) AS fakes
    FROM invite_daily_stats WHERE guild_id = ${guildId} AND day >= ${keys[0]}
    GROUP BY day, source
  `);
  for (const row of folded) {
    const entry = byDay.get(row.day);
    if (!entry) continue;
    entry[asSource(row.source)] += Number(row.joins) || 0;
    entry.leaves += Number(row.leaves) || 0;
    entry.fakes += Number(row.fakes) || 0;
  }

  return keys.map((key) => byDay.get(key)!);
}

/**
 * Share of joins (bots excluded) still in the server `n` days after joining, among joins in the
 * window that are at least `n` days old. Null when there are none yet.
 */
export function retentionShare(guildId: string, sinceMs: number, days: number, now = Date.now()): number | null {
  const span = days * DAY_MS;
  const row = getDb().get<{ eligible: number; stayed: number }>(sql`
    SELECT COUNT(*) AS eligible,
      SUM(CASE WHEN left_at IS NULL OR left_at - joined_at >= ${span} THEN 1 ELSE 0 END) AS stayed
    FROM invite_joins
    WHERE guild_id = ${guildId} AND source <> 'oauth' AND joined_at >= ${sinceMs} AND joined_at <= ${now - span}
  `);
  const eligible = Number(row?.eligible) || 0;
  return eligible > 0 ? (Number(row?.stayed) || 0) / eligible : null;
}

/** Top inviters by joins inside the window only (resets and bonuses don't apply here). */
export function topInvitersInWindow(guildId: string, sinceMs: number, limit = 10): InviterCounts[] {
  const rows = getDb().all<{ user_id: string; regular: number; left_n: number; fake: number }>(sql`
    SELECT inviter_id AS user_id,
      SUM(CASE WHEN status <> 'pending' THEN 1 ELSE 0 END) AS regular,
      SUM(CASE WHEN status = 'valid' AND left_at IS NOT NULL THEN 1 ELSE 0 END) AS left_n,
      SUM(CASE WHEN status = 'fake' THEN 1 ELSE 0 END) AS fake
    FROM invite_joins
    WHERE guild_id = ${guildId} AND inviter_id IS NOT NULL AND counted = 1 AND joined_at >= ${sinceMs}
    GROUP BY inviter_id
  `);
  return rows
    .map((row) => ({
      userId: row.user_id,
      ...withTotal({ regular: Number(row.regular) || 0, left: Number(row.left_n) || 0, fake: Number(row.fake) || 0, bonus: 0 }),
    }))
    .filter((row) => row.regular > 0)
    .sort((a, b) => b.total - a.total || b.regular - a.regular)
    .slice(0, limit);
}

export function buildAnalytics(guildId: string, range: AnalyticsRange, now = Date.now()): InviteAnalytics {
  const days = dailySeries(guildId, ANALYTICS_RANGES[range], now);
  const sinceMs = Date.parse(`${days[0]!.day}T00:00:00.000Z`);
  const sources = { invite: 0, tracked: 0, vanity: 0, oauth: 0, unknown: 0 } satisfies Record<JoinSource, number>;
  for (const day of days) for (const source of JOIN_SOURCES) sources[source] += day[source];

  const stats = trackedLinkStats(guildId, new Date(sinceMs));
  // Live links always show; deleted ones only while they still have joins in the window.
  const links = listTrackedLinks(guildId, { includeDeleted: true })
    .filter((link) => !link.deletedAt || stats.has(link.id))
    .map((link) => ({ id: link.id, name: link.name, ...(stats.get(link.id) ?? { joins: 0, stayed: 0, left: 0, fake: 0 }) }))
    .sort((a, b) => b.joins - a.joins);

  return {
    range,
    days,
    sources,
    retention: {
      d1: retentionShare(guildId, sinceMs, 1, now),
      d7: retentionShare(guildId, sinceMs, 7, now),
      d30: retentionShare(guildId, sinceMs, 30, now),
    },
    topInviters: topInvitersInWindow(guildId, sinceMs),
    links,
  };
}

/** Joins in the last 30 days, and how many of them couldn't be attributed. */
export function recentJoinTotals(guildId: string, now = Date.now()): { joins30d: number; unknown30d: number } {
  let joins30d = 0;
  let unknown30d = 0;
  for (const day of dailySeries(guildId, 30, now)) {
    for (const source of JOIN_SOURCES) joins30d += day[source];
    unknown30d += day.unknown;
  }
  return { joins30d, unknown30d };
}
