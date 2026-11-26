import { ChannelType, type Guild } from "discord.js";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import {
  guildStatsChannelDaily,
  guildStatsChannelVoiceDaily,
  guildStatsDaily,
  guildStatsUserDaily,
  guildStatsUserVoiceDaily,
  guildUserTrail,
} from "../db/schema.js";
import { formatSharePct, sharePctValue } from "../plugins/stats/functions/analysis.js";
import { dateRangeInclusive, statDate } from "../plugins/stats/functions/daily.js";
import { getActiveMessagerCount, getUserMessageRank } from "../plugins/stats/functions/queries.js";
import { getGuildMessageCount } from "../plugins/utility/functions/messageCounts.js";
import { listHiddenFromLeaderboards } from "../core/privacy/ghostMode.js";
import { resolveTopPeople } from "./leaderboards.js";
import type { WebStatsRangeQuery } from "./webStatsRange.js";

/**
 * Member and channel detail views for the stats page's date range. Both are scoped to one guild.
 * A member goes through the same identity filter as every ranking (Ghost Mode, hidden from
 * leaderboards, unresolvable), so a hidden member can't be reached by URL either: the payload is
 * just `{ available: false }`. A channel must belong to the guild (or have stats rows in it).
 */

const TOP = 10;

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function minusOneYear(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y - 1, m - 1, Math.min(d, m === 2 ? 28 : d))).toISOString().slice(0, 10);
}

function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

function secondsExpr(seconds: unknown, minutes: unknown) {
  return sql<number>`MAX(${seconds}, ${minutes} * 60)`;
}

async function earliest(guildId: string): Promise<string> {
  const row = await getDb()
    .select({ first: sql<string | null>`min(${guildStatsDaily.statDate})` })
    .from(guildStatsDaily)
    .where(eq(guildStatsDaily.guildId, guildId))
    .get();
  return row?.first ?? statDate();
}

/** The range (clamped to tracking start) and its comparison range, same rules as the guild view. */
async function resolveRanges(guildId: string, query: WebStatsRangeQuery) {
  const first = await earliest(guildId);
  const from = query.from < first ? (first > query.to ? query.to : first) : query.from;
  const to = query.to;
  const span = spanDays(from, to);
  let compare: { from: string; to: string } | null = null;
  if (query.compare === "prev") compare = { from: addDays(from, -span), to: addDays(from, -1) };
  else if (query.compare === "year") compare = { from: minusOneYear(from), to: minusOneYear(to) };
  if (compare && compare.to < first) compare = null;
  return { first, from, to, compare };
}

function fill<T extends { statDate: string }>(from: string, to: string, rows: T[], pick: (row: T) => number): Array<{ date: string; value: number }> {
  const by = new Map(rows.map((r) => [r.statDate, pick(r)]));
  return dateRangeInclusive(from, to).map((date) => ({ date, value: by.get(date) ?? 0 }));
}

function toSeconds(iso: string, endOfDay = false): Date {
  return new Date(Date.parse(`${iso}T${endOfDay ? "23:59:59" : "00:00:00"}Z`));
}

/** Message-weighted UTC weekday x hour grid from the message trail (168 cells). */
function trailHeatmap(rows: Array<{ startedAt: Date; messageCount: number }>) {
  const grid = new Map<string, number>();
  for (const row of rows) {
    const d = row.startedAt;
    const key = `${d.getUTCDay()}:${d.getUTCHours()}`;
    grid.set(key, (grid.get(key) ?? 0) + row.messageCount);
  }
  const out: Array<{ weekday: number; hour: number; value: number }> = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) out.push({ weekday, hour, value: grid.get(`${weekday}:${hour}`) ?? 0 });
  }
  return out;
}

function channelName(guild: Guild, channelId: string): string {
  const channel = guild.channels.cache.get(channelId);
  return channel && "name" in channel && channel.name ? `#${channel.name}` : `#${channelId}`;
}

// --- Member -----------------------------------------------------------------------------------------

async function memberDays(guildId: string, userId: string, from: string, to: string) {
  const db = getDb();
  const voiceSecs = secondsExpr(guildStatsUserVoiceDaily.seconds, guildStatsUserVoiceDaily.minutes);
  const [messages, voice] = await Promise.all([
    db
      .select({ statDate: guildStatsUserDaily.statDate, messages: guildStatsUserDaily.messages })
      .from(guildStatsUserDaily)
      .where(
        and(
          eq(guildStatsUserDaily.guildId, guildId),
          eq(guildStatsUserDaily.userId, userId),
          gte(guildStatsUserDaily.statDate, from),
          lte(guildStatsUserDaily.statDate, to),
        ),
      ),
    db
      .select({ statDate: guildStatsUserVoiceDaily.statDate, seconds: voiceSecs })
      .from(guildStatsUserVoiceDaily)
      .where(
        and(
          eq(guildStatsUserVoiceDaily.guildId, guildId),
          eq(guildStatsUserVoiceDaily.userId, userId),
          gte(guildStatsUserVoiceDaily.statDate, from),
          lte(guildStatsUserVoiceDaily.statDate, to),
        ),
      ),
  ]);
  const msg = fill(from, to, messages, (r) => r.messages);
  const vc = fill(from, to, voice, (r) => Math.round(Number(r.seconds ?? 0) / 60));
  return msg.map((m, i) => ({ date: m.date, messages: m.value, voiceMinutes: vc[i]?.value ?? 0 }));
}

/** Rank by messages within the range, and how many members posted in it. */
async function rangeRank(guildId: string, from: string, to: string, total: number) {
  const db = getDb();
  const sums = db
    .select({ userId: guildStatsUserDaily.userId, s: sql<number>`sum(${guildStatsUserDaily.messages})`.as("s") })
    .from(guildStatsUserDaily)
    .where(and(eq(guildStatsUserDaily.guildId, guildId), gte(guildStatsUserDaily.statDate, from), lte(guildStatsUserDaily.statDate, to)))
    .groupBy(guildStatsUserDaily.userId)
    .as("sums");
  const [above, pool] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(sums).where(sql`${sums.s} > ${total}`).get(),
    db.select({ n: sql<number>`count(*)` }).from(sums).where(sql`${sums.s} > 0`).get(),
  ]);
  return { rank: total > 0 ? Number(above?.n ?? 0) + 1 : null, pool: Number(pool?.n ?? 0) };
}

export async function buildWebGuildMemberRange(guild: Guild, memberId: string, query: WebStatsRangeQuery) {
  const guildId = guild.id;
  // Same filter as every ranking: hidden or unresolvable members are not shown at all.
  if (listHiddenFromLeaderboards().has(memberId)) return { available: false as const };
  const [identity] = await resolveTopPeople(guild.client, [{ userId: memberId, count: 0 }], 0, { limit: 1, guild });
  if (!identity) return { available: false as const };

  const { first, from, to, compare } = await resolveRanges(guildId, query);
  const [days, compareDays, lifetime, pool, trail] = await Promise.all([
    memberDays(guildId, memberId, from, to),
    compare ? memberDays(guildId, memberId, compare.from, compare.to) : Promise.resolve(null),
    getGuildMessageCount(guildId, memberId),
    getActiveMessagerCount(guildId),
    getDb()
      .select({ channelId: guildUserTrail.channelId, startedAt: guildUserTrail.startedAt, messageCount: guildUserTrail.messageCount })
      .from(guildUserTrail)
      .where(
        and(
          eq(guildUserTrail.guildId, guildId),
          eq(guildUserTrail.userId, memberId),
          gte(guildUserTrail.endedAt, toSeconds(from)),
          lte(guildUserTrail.startedAt, toSeconds(to, true)),
        ),
      ),
  ]);
  const total = days.reduce((a, d) => a + d.messages, 0);
  const compareTotal = compareDays ? compareDays.reduce((a, d) => a + d.messages, 0) : 0;
  const [lifetimeRank, range, compareRank] = await Promise.all([
    getUserMessageRank(guildId, memberId, lifetime),
    rangeRank(guildId, from, to, total),
    compare ? rangeRank(guildId, compare.from, compare.to, compareTotal) : Promise.resolve(null),
  ]);

  const byChannel = new Map<string, number>();
  for (const row of trail) byChannel.set(row.channelId, (byChannel.get(row.channelId) ?? 0) + row.messageCount);
  const trailTotal = [...byChannel.values()].reduce((a, b) => a + b, 0);
  const topChannels = [...byChannel.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP)
    .map(([id, count], index) => ({
      rank: index + 1,
      id,
      name: channelName(guild, id),
      count,
      sharePct: sharePctValue(count, trailTotal),
      shareLabel: formatSharePct(count, trailTotal),
    }));

  return {
    available: true as const,
    from,
    to,
    bounds: { earliest: first, latest: statDate() },
    member: {
      id: memberId,
      name: identity.name,
      username: identity.username ?? null,
      avatar: identity.avatar ?? null,
      bannerUrl: identity.bannerUrl ?? null,
    },
    days,
    compare: compare && compareDays ? { from: compare.from, to: compare.to, days: compareDays, rank: compareRank?.rank ?? null } : null,
    rank: { range: range.rank, rangePool: range.pool, lifetime: lifetime > 0 ? lifetimeRank : null, lifetimePool: pool },
    lifetimeMessages: lifetime,
    topChannels,
    heatmap: trailHeatmap(trail),
  };
}

// --- Channel ----------------------------------------------------------------------------------------

const CHANNEL_KINDS: Partial<Record<ChannelType, string>> = {
  [ChannelType.GuildText]: "text",
  [ChannelType.GuildVoice]: "voice",
  [ChannelType.GuildAnnouncement]: "announcement",
  [ChannelType.GuildForum]: "forum",
  [ChannelType.GuildStageVoice]: "stage",
  [ChannelType.PublicThread]: "thread",
  [ChannelType.PrivateThread]: "thread",
  [ChannelType.AnnouncementThread]: "thread",
  [ChannelType.GuildMedia]: "forum",
};

async function channelDays(guildId: string, channelId: string, from: string, to: string) {
  const db = getDb();
  const voiceSecs = secondsExpr(guildStatsChannelVoiceDaily.seconds, guildStatsChannelVoiceDaily.minutes);
  const [messages, voice] = await Promise.all([
    db
      .select({ statDate: guildStatsChannelDaily.statDate, messages: guildStatsChannelDaily.messages })
      .from(guildStatsChannelDaily)
      .where(
        and(
          eq(guildStatsChannelDaily.guildId, guildId),
          eq(guildStatsChannelDaily.channelId, channelId),
          gte(guildStatsChannelDaily.statDate, from),
          lte(guildStatsChannelDaily.statDate, to),
        ),
      ),
    db
      .select({ statDate: guildStatsChannelVoiceDaily.statDate, seconds: voiceSecs, peak: guildStatsChannelVoiceDaily.peakConcurrent })
      .from(guildStatsChannelVoiceDaily)
      .where(
        and(
          eq(guildStatsChannelVoiceDaily.guildId, guildId),
          eq(guildStatsChannelVoiceDaily.channelId, channelId),
          gte(guildStatsChannelVoiceDaily.statDate, from),
          lte(guildStatsChannelVoiceDaily.statDate, to),
        ),
      ),
  ]);
  const msg = fill(from, to, messages, (r) => r.messages);
  const vc = fill(from, to, voice, (r) => Math.round(Number(r.seconds ?? 0) / 60));
  const peak = fill(from, to, voice, (r) => Number(r.peak ?? 0));
  return msg.map((m, i) => ({ date: m.date, messages: m.value, voiceMinutes: vc[i]?.value ?? 0, voicePeak: peak[i]?.value ?? 0 }));
}

export async function buildWebGuildChannelRange(guild: Guild, channelId: string, query: WebStatsRangeQuery) {
  const guildId = guild.id;
  const channel = guild.channels.cache.get(channelId) ?? null;
  if (!channel) {
    // A deleted channel can still have stats here; anything else isn't this guild's.
    const [hasText, hasVoice] = await Promise.all([
      getDb().select({ n: sql<number>`1` }).from(guildStatsChannelDaily).where(and(eq(guildStatsChannelDaily.guildId, guildId), eq(guildStatsChannelDaily.channelId, channelId))).limit(1).get(),
      getDb().select({ n: sql<number>`1` }).from(guildStatsChannelVoiceDaily).where(and(eq(guildStatsChannelVoiceDaily.guildId, guildId), eq(guildStatsChannelVoiceDaily.channelId, channelId))).limit(1).get(),
    ]);
    if (!hasText && !hasVoice) return { available: false as const };
  }

  const { first, from, to, compare } = await resolveRanges(guildId, query);
  const [days, compareDays, trail] = await Promise.all([
    channelDays(guildId, channelId, from, to),
    compare ? channelDays(guildId, channelId, compare.from, compare.to) : Promise.resolve(null),
    getDb()
      .select({ userId: guildUserTrail.userId, startedAt: guildUserTrail.startedAt, messageCount: guildUserTrail.messageCount })
      .from(guildUserTrail)
      .where(
        and(
          eq(guildUserTrail.guildId, guildId),
          eq(guildUserTrail.channelId, channelId),
          gte(guildUserTrail.endedAt, toSeconds(from)),
          lte(guildUserTrail.startedAt, toSeconds(to, true)),
        ),
      )
      .orderBy(desc(guildUserTrail.startedAt))
      .limit(20_000),
  ]);

  const byUser = new Map<string, number>();
  for (const row of trail) byUser.set(row.userId, (byUser.get(row.userId) ?? 0) + row.messageCount);
  const trailTotal = [...byUser.values()].reduce((a, b) => a + b, 0);
  const topMembers = await resolveTopPeople(
    guild.client,
    [...byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP * 3).map(([userId, count]) => ({ userId, count })),
    trailTotal,
    { limit: TOP, guild },
  );

  const type = channel ? (CHANNEL_KINDS[channel.type] ?? "text") : days.some((d) => d.voiceMinutes > 0) ? "voice" : "text";
  return {
    available: true as const,
    from,
    to,
    bounds: { earliest: first, latest: statDate() },
    channel: {
      id: channelId,
      name: channel && "name" in channel && channel.name ? channel.name : channelId,
      type,
      deleted: !channel,
      parentName: channel && "parent" in channel && channel.parent ? channel.parent.name : null,
    },
    days,
    compare: compare && compareDays ? { from: compare.from, to: compare.to, days: compareDays } : null,
    topMembers,
    /** Distinct members seen posting here in the message trail for this range. */
    posters: byUser.size,
    heatmap: trailHeatmap(trail),
  };
}
