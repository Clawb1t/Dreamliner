import type { Client } from "discord.js";
import { fetchMemberCached } from "./people.js";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { guildMessageCounts, guildStatsUserDaily, userHourlyActivity } from "../db/schema.js";
import { dateRange, windowSince } from "../plugins/stats/functions/daily.js";
import { guildRank, guildTrafficTotal } from "./userStats.js";

/** Last `days` days of message activity, summed across every server, oldest → newest. */
export async function getUserDailyActivity(
  userId: string,
  days: number,
): Promise<Array<{ date: string; messages: number }>> {
  const since = windowSince(days);
  const dates = dateRange(days);
  if (!since) return dates.map((date) => ({ date, messages: 0 }));

  const rows = await getDb()
    .select({
      date: guildStatsUserDaily.statDate,
      messages: sql<number>`coalesce(sum(${guildStatsUserDaily.messages}), 0)`,
    })
    .from(guildStatsUserDaily)
    .where(and(eq(guildStatsUserDaily.userId, userId), gte(guildStatsUserDaily.statDate, since)))
    .groupBy(guildStatsUserDaily.statDate)
    .all();

  const map = new Map(rows.map((row) => [row.date, Number(row.messages ?? 0)]));
  return dates.map((date) => ({ date, messages: map.get(date) ?? 0 }));
}

/** Lifetime message count per UTC hour-of-day (0-23), for "active hours". */
export async function getUserHourlyActivity(userId: string): Promise<number[]> {
  const rows = await getDb()
    .select()
    .from(userHourlyActivity)
    .where(eq(userHourlyActivity.userId, userId))
    .all();
  const hours = new Array(24).fill(0) as number[];
  for (const row of rows) {
    if (row.hourUtc >= 0 && row.hourUtc < 24) hours[row.hourUtc] = row.count;
  }
  return hours;
}

export type UserGuildSummary = {
  id: string;
  name: string;
  icon: string | null;
  /** Guild banner, for the same blurred-backdrop card treatment the dashboard's own server
   *  picker uses — falls back to the icon (also blurred) when the guild has no banner set. */
  bannerUrl: string | null;
  messages: number;
  /** This user's message-count rank within that server (1 = top messager), null if unranked. */
  rank: number | null;
  /** Share of that server's total tracked messages this user accounts for, 0-100. */
  sharePct: number | null;
  oneActive: boolean;
  /** ISO timestamp of when the guild's current subscription started, null if inactive/unknown —
   *  powers the One badge's "subscribed for X" tooltip next to the server name. */
  oneActiveSince: string | null;
};

/**
 * Servers this user has messaged in, shown on the public profile's "As seen in these servers"
 * section. A server is only included when the bot is still in it and the user is still a member
 * of it — no separate per-guild opt-in beyond that: server pages and leaderboards are
 * unconditionally public now (see `leaderboardAlwaysPublic` in publicGuild.ts), so there's
 * nothing left to gate this on. This used to also require `public_stats.activity`, a config field
 * that predates that change, was never exposed in the dashboard for any guild owner to actually
 * set, and defaulted to `false` — meaning this silently returned nothing for every user. The
 * user's own `hideServersSection` profile setting (checked by the caller) is the real, working
 * privacy control here.
 */
export async function listUserGuildSummaries(
  client: Client,
  userId: string,
  limit = 12,
): Promise<UserGuildSummary[]> {
  const rows = await getDb()
    .select()
    .from(guildMessageCounts)
    .where(eq(guildMessageCounts.userId, userId))
    .all();

  // Only the servers that can make the cut are checked for membership, and those checks run
  // together (shared and remembered, see people.ts) instead of one Discord request after another
  // across every server the person has ever spoken in.
  const candidates = rows
    .filter((row) => client.guilds.cache.has(row.guildId))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit * 3);
  // Membership checks may need Discord; the page gets at most ~2.5s of them. A server not confirmed
  // in time is left out of this view (its check finishes in the background and is remembered, so
  // the next view includes it) rather than holding the whole profile up.
  const deadline = Date.now() + 2500;
  const checked = await Promise.all(
    candidates.map(async (row) => {
      const guild = client.guilds.cache.get(row.guildId)!;
      const lookup = fetchMemberCached(guild, userId);
      const member = await Promise.race([
        lookup,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))),
      ]);
      return member
        ? {
            guildId: row.guildId,
            name: guild.name,
            icon: guild.iconURL({ size: 64 }),
            bannerUrl: guild.bannerURL({ size: 512 }),
            messages: row.count,
          }
        : null;
    }),
  );
  const eligible = checked.filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  // Rank/share need one more query each per server, so only compute them for the servers that
  // actually make the cut, not every eligible one.
  const top = eligible.sort((a, b) => b.messages - a.messages).slice(0, limit);
  const { listActiveOneGuildsSince } = await import("./dreamlinerOne.js");
  const oneSince = await listActiveOneGuildsSince();
  return Promise.all(
    top.map(async (entry) => {
      const [rank, traffic] = await Promise.all([
        guildRank(entry.guildId, entry.messages),
        guildTrafficTotal(entry.guildId),
      ]);
      return {
        id: entry.guildId,
        name: entry.name,
        icon: entry.icon,
        bannerUrl: entry.bannerUrl,
        messages: entry.messages,
        rank,
        sharePct: traffic > 0 ? Math.round((entry.messages / traffic) * 1000) / 10 : null,
        oneActive: oneSince.has(entry.guildId),
        oneActiveSince: oneSince.get(entry.guildId) ?? null,
      };
    }),
  );
}
