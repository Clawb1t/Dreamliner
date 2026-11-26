import type { Guild } from "discord.js";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import {
  commandUsageDaily,
  guildStatsChannelDaily,
  guildStatsChannelVoiceDaily,
  guildStatsDaily,
  guildStatsHourlyBucket,
  guildStatsUserDaily,
  guildStatsUserVoiceDaily,
  guildStatsVoiceDaily,
} from "../db/schema.js";
import { formatSharePct, sharePctValue } from "../plugins/stats/functions/analysis.js";
import { dateRangeInclusive, getFilledDailyStatsInRange, statDate } from "../plugins/stats/functions/daily.js";
import { getGuildVoiceHourlyHeatmap } from "../plugins/stats/functions/voice.js";
import { resolveTopPeople } from "./leaderboards.js";

/**
 * The dashboard stats page's date-range view: every daily counter, plus the ranked lists, for an
 * explicit inclusive UTC date range (`?from=&to=`), with an optional comparison range. Scoped to one
 * guild, bounded to that guild's own recorded data and to MAX_SPAN_DAYS, and cached per range key by
 * the caller. Ranked people go through resolveTopPeople, so Ghost Mode and unresolvable users are
 * skipped exactly as on the fixed-window payload.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Longest range (and comparison range) one request may cover. */
export const MAX_SPAN_DAYS = 731;
/** Hourly buckets are only kept for about 8 days, and only make sense for very short ranges. */
const HOURLY_MAX_DAYS = 2;
const TOP_PEOPLE = 15;
const TOP_PEOPLE_CANDIDATES = 45;
const TOP_OTHER = 15;

export type WebStatsCompareMode = "none" | "prev" | "year";

export type WebStatsRangeQuery = {
  from: string;
  to: string;
  compare: WebStatsCompareMode;
};

function isIsoDate(value: string | null): value is string {
  if (!value || !ISO_DATE_RE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

function minusOneYear(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  // 29 Feb maps to 28 Feb.
  const date = new Date(Date.UTC(y - 1, m - 1, Math.min(d, m === 2 ? 28 : d)));
  return date.toISOString().slice(0, 10);
}

/** Validates `?from=&to=&compare=`. Returns an error string for anything malformed; the range is
 *  clamped to today and to MAX_SPAN_DAYS (keeping the end date) rather than rejected. */
export function parseWebStatsRangeQuery(url: URL): WebStatsRangeQuery | { error: string } {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!isIsoDate(from) || !isIsoDate(to)) return { error: "from and to must be YYYY-MM-DD dates" };
  if (from > to) return { error: "from must not be after to" };
  const today = statDate();
  const end = to > today ? today : to;
  let start = from > end ? end : from;
  if (spanDays(start, end) > MAX_SPAN_DAYS) start = addDays(end, -(MAX_SPAN_DAYS - 1));
  const rawCompare = url.searchParams.get("compare");
  const compare: WebStatsCompareMode = rawCompare === "prev" || rawCompare === "year" ? rawCompare : "none";
  return { from: start, to: end, compare };
}

async function earliestStatDate(guildId: string): Promise<string | null> {
  const row = await getDb()
    .select({ first: sql<string | null>`min(${guildStatsDaily.statDate})` })
    .from(guildStatsDaily)
    .where(eq(guildStatsDaily.guildId, guildId))
    .get();
  return row?.first ?? null;
}

function effectiveSeconds(seconds: unknown, minutes: unknown) {
  return sql<number>`MAX(${seconds}, ${minutes} * 60)`;
}

type RangeDay = {
  date: string;
  messages: number;
  joins: number;
  leaves: number;
  edits: number;
  deletes: number;
  reactions: number;
  attachments: number;
  active: number;
  voiceMinutes: number;
  voicePeak: number;
  commands: number;
};

/** Zero-filled day rows for one range, every counter the page charts. */
async function rangeDays(guildId: string, from: string, to: string): Promise<RangeDay[]> {
  const db = getDb();
  const [daily, active, voice, commands] = await Promise.all([
    getFilledDailyStatsInRange(guildId, from, to),
    db
      .select({
        statDate: guildStatsUserDaily.statDate,
        count: sql<number>`count(distinct ${guildStatsUserDaily.userId})`,
      })
      .from(guildStatsUserDaily)
      .where(
        and(
          eq(guildStatsUserDaily.guildId, guildId),
          gte(guildStatsUserDaily.statDate, from),
          lte(guildStatsUserDaily.statDate, to),
          sql`${guildStatsUserDaily.messages} > 0`,
        ),
      )
      .groupBy(guildStatsUserDaily.statDate),
    db
      .select({
        statDate: guildStatsVoiceDaily.statDate,
        seconds: effectiveSeconds(guildStatsVoiceDaily.seconds, guildStatsVoiceDaily.minutes),
        peak: guildStatsVoiceDaily.peakConcurrent,
      })
      .from(guildStatsVoiceDaily)
      .where(
        and(
          eq(guildStatsVoiceDaily.guildId, guildId),
          gte(guildStatsVoiceDaily.statDate, from),
          lte(guildStatsVoiceDaily.statDate, to),
        ),
      ),
    db
      .select({
        statDate: commandUsageDaily.statDate,
        uses: sql<number>`coalesce(sum(${commandUsageDaily.uses}), 0)`,
      })
      .from(commandUsageDaily)
      .where(
        and(
          eq(commandUsageDaily.guildId, guildId),
          gte(commandUsageDaily.statDate, from),
          lte(commandUsageDaily.statDate, to),
        ),
      )
      .groupBy(commandUsageDaily.statDate),
  ]);
  const activeBy = new Map(active.map((row) => [row.statDate, Number(row.count ?? 0)]));
  const voiceBy = new Map(voice.map((row) => [row.statDate, row]));
  const commandsBy = new Map(commands.map((row) => [row.statDate, Number(row.uses ?? 0)]));
  return daily.map((row) => {
    const v = voiceBy.get(row.statDate);
    return {
      date: row.statDate,
      messages: row.messages,
      joins: row.joins,
      leaves: row.leaves,
      edits: row.edits,
      deletes: row.deletes,
      reactions: row.reactions,
      attachments: row.attachments,
      active: activeBy.get(row.statDate) ?? 0,
      voiceMinutes: v ? Math.round(Number(v.seconds ?? 0) / 60) : 0,
      voicePeak: v ? Number(v.peak ?? 0) : 0,
      commands: commandsBy.get(row.statDate) ?? 0,
    };
  });
}

/** Distinct members who posted, and who spent time in voice, across the whole range. */
async function rangeDistinct(guildId: string, from: string, to: string) {
  const db = getDb();
  const [posters, voice] = await Promise.all([
    db
      .select({ n: sql<number>`count(distinct ${guildStatsUserDaily.userId})` })
      .from(guildStatsUserDaily)
      .where(
        and(
          eq(guildStatsUserDaily.guildId, guildId),
          gte(guildStatsUserDaily.statDate, from),
          lte(guildStatsUserDaily.statDate, to),
          sql`${guildStatsUserDaily.messages} > 0`,
        ),
      )
      .get(),
    db
      .select({ n: sql<number>`count(distinct ${guildStatsUserVoiceDaily.userId})` })
      .from(guildStatsUserVoiceDaily)
      .where(
        and(
          eq(guildStatsUserVoiceDaily.guildId, guildId),
          gte(guildStatsUserVoiceDaily.statDate, from),
          lte(guildStatsUserVoiceDaily.statDate, to),
        ),
      )
      .get(),
  ]);
  return { activeMembers: Number(posters?.n ?? 0), voiceMembers: Number(voice?.n ?? 0) };
}

function channelName(guild: Guild, channelId: string): string {
  const channel = guild.channels.cache.get(channelId);
  return channel && "name" in channel && channel.name ? `#${channel.name}` : `#${channelId}`;
}

function rankRows(entries: Array<{ id: string; name: string; count: number }>, total: number) {
  return entries.map((entry, index) => ({
    rank: index + 1,
    id: entry.id,
    name: entry.name,
    count: entry.count,
    sharePct: sharePctValue(entry.count, total),
    shareLabel: formatSharePct(entry.count, total),
  }));
}

async function rangeLeaders(guild: Guild, from: string, to: string, totals: { messages: number; voice: number; commands: number }) {
  const db = getDb();
  const guildId = guild.id;
  const userSecs = effectiveSeconds(guildStatsUserVoiceDaily.seconds, guildStatsUserVoiceDaily.minutes);
  const channelSecs = effectiveSeconds(guildStatsChannelVoiceDaily.seconds, guildStatsChannelVoiceDaily.minutes);
  const [users, channels, voiceUsers, voiceChannels, commands] = await Promise.all([
    db
      .select({ userId: guildStatsUserDaily.userId, count: sql<number>`coalesce(sum(${guildStatsUserDaily.messages}), 0)` })
      .from(guildStatsUserDaily)
      .where(and(eq(guildStatsUserDaily.guildId, guildId), gte(guildStatsUserDaily.statDate, from), lte(guildStatsUserDaily.statDate, to)))
      .groupBy(guildStatsUserDaily.userId)
      .orderBy(desc(sql`coalesce(sum(${guildStatsUserDaily.messages}), 0)`))
      .limit(TOP_PEOPLE_CANDIDATES),
    db
      .select({ channelId: guildStatsChannelDaily.channelId, count: sql<number>`coalesce(sum(${guildStatsChannelDaily.messages}), 0)` })
      .from(guildStatsChannelDaily)
      .where(and(eq(guildStatsChannelDaily.guildId, guildId), gte(guildStatsChannelDaily.statDate, from), lte(guildStatsChannelDaily.statDate, to)))
      .groupBy(guildStatsChannelDaily.channelId)
      .orderBy(desc(sql`coalesce(sum(${guildStatsChannelDaily.messages}), 0)`))
      .limit(TOP_OTHER),
    db
      .select({ userId: guildStatsUserVoiceDaily.userId, seconds: sql<number>`coalesce(sum(${userSecs}), 0)` })
      .from(guildStatsUserVoiceDaily)
      .where(and(eq(guildStatsUserVoiceDaily.guildId, guildId), gte(guildStatsUserVoiceDaily.statDate, from), lte(guildStatsUserVoiceDaily.statDate, to)))
      .groupBy(guildStatsUserVoiceDaily.userId)
      .orderBy(desc(sql`coalesce(sum(${userSecs}), 0)`))
      .limit(TOP_PEOPLE_CANDIDATES),
    db
      .select({ channelId: guildStatsChannelVoiceDaily.channelId, seconds: sql<number>`coalesce(sum(${channelSecs}), 0)` })
      .from(guildStatsChannelVoiceDaily)
      .where(
        and(
          eq(guildStatsChannelVoiceDaily.guildId, guildId),
          gte(guildStatsChannelVoiceDaily.statDate, from),
          lte(guildStatsChannelVoiceDaily.statDate, to),
        ),
      )
      .groupBy(guildStatsChannelVoiceDaily.channelId)
      .orderBy(desc(sql`coalesce(sum(${channelSecs}), 0)`))
      .limit(TOP_OTHER),
    db
      .select({ commandName: commandUsageDaily.commandName, count: sql<number>`coalesce(sum(${commandUsageDaily.uses}), 0)` })
      .from(commandUsageDaily)
      .where(and(eq(commandUsageDaily.guildId, guildId), gte(commandUsageDaily.statDate, from), lte(commandUsageDaily.statDate, to)))
      .groupBy(commandUsageDaily.commandName)
      .orderBy(desc(sql`coalesce(sum(${commandUsageDaily.uses}), 0)`))
      .limit(TOP_OTHER),
  ]);

  const [topMembers, topVoiceMembers] = await Promise.all([
    resolveTopPeople(
      guild.client,
      users.filter((row) => Number(row.count) > 0).map((row) => ({ userId: row.userId, count: Number(row.count) })),
      totals.messages,
      { limit: TOP_PEOPLE, guild },
    ),
    resolveTopPeople(
      guild.client,
      voiceUsers
        .filter((row) => Number(row.seconds) > 0)
        .map((row) => ({ userId: row.userId, count: Math.round(Number(row.seconds) / 60), seconds: Number(row.seconds) })),
      totals.voice,
      { limit: TOP_PEOPLE, guild },
    ),
  ]);

  return {
    topMembers,
    topChannels: rankRows(
      channels.filter((row) => Number(row.count) > 0).map((row) => ({ id: row.channelId, name: channelName(guild, row.channelId), count: Number(row.count) })),
      totals.messages,
    ),
    topVoiceMembers,
    topVoiceChannels: rankRows(
      voiceChannels
        .filter((row) => Number(row.seconds) > 0)
        .map((row) => ({ id: row.channelId, name: channelName(guild, row.channelId), count: Math.round(Number(row.seconds) / 60) })),
      totals.voice,
    ),
    topCommands: rankRows(
      commands.filter((row) => Number(row.count) > 0).map((row) => ({ id: row.commandName, name: `/${row.commandName}`, count: Number(row.count) })),
      totals.commands,
    ),
  };
}

/** Hour-by-hour rows (UTC bucket hours) for a 1 to 2 day range still inside bucket retention. */
async function rangeHours(guildId: string, from: string, to: string) {
  const rows = await getDb()
    .select()
    .from(guildStatsHourlyBucket)
    .where(
      and(
        eq(guildStatsHourlyBucket.guildId, guildId),
        gte(guildStatsHourlyBucket.bucketHour, `${from}T00`),
        lte(guildStatsHourlyBucket.bucketHour, `${to}T23`),
      ),
    );
  const byHour = new Map(rows.map((row) => [row.bucketHour, row]));
  const out: Array<{ hour: string; messages: number; joins: number; leaves: number; edits: number; deletes: number; reactions: number; attachments: number }> = [];
  for (const date of dateRangeInclusive(from, to)) {
    for (let h = 0; h < 24; h++) {
      const key = `${date}T${String(h).padStart(2, "0")}`;
      const row = byHour.get(key);
      out.push({
        hour: `${key}:00:00Z`,
        messages: row?.messages ?? 0,
        joins: row?.joins ?? 0,
        leaves: row?.leaves ?? 0,
        edits: row?.edits ?? 0,
        deletes: row?.deletes ?? 0,
        reactions: row?.reactions ?? 0,
        attachments: row?.attachments ?? 0,
      });
    }
  }
  return out;
}

function sum(days: RangeDay[], key: keyof Omit<RangeDay, "date">): number {
  return days.reduce((acc, row) => acc + row[key], 0);
}

export async function buildWebGuildStatsRange(guild: Guild, query: WebStatsRangeQuery) {
  const guildId = guild.id;
  const today = statDate();
  const earliest = (await earliestStatDate(guildId)) ?? today;
  // Bounded to this guild's own data: nothing before tracking began is queried for the main range.
  const from = query.from < earliest ? (earliest > query.to ? query.to : earliest) : query.from;
  const to = query.to;
  const span = spanDays(from, to);

  let compareRange: { from: string; to: string } | null = null;
  if (query.compare === "prev") {
    compareRange = { from: addDays(from, -span), to: addDays(from, -1) };
  } else if (query.compare === "year") {
    compareRange = { from: minusOneYear(from), to: minusOneYear(to) };
  }
  // A comparison entirely before tracking began has nothing to show.
  if (compareRange && compareRange.to < earliest) compareRange = null;

  const hourlyEligible =
    span <= HOURLY_MAX_DAYS && Date.parse(`${from}T00:00:00Z`) >= Date.now() - 7 * 86_400_000;

  const [days, distinct, compareDays, compareDistinct, hours, voiceHeatmap] = await Promise.all([
    rangeDays(guildId, from, to),
    rangeDistinct(guildId, from, to),
    compareRange ? rangeDays(guildId, compareRange.from, compareRange.to) : Promise.resolve(null),
    compareRange ? rangeDistinct(guildId, compareRange.from, compareRange.to) : Promise.resolve(null),
    hourlyEligible ? rangeHours(guildId, from, to) : Promise.resolve(null),
    // Lifetime voice minutes by UTC weekday x hour (not range-scoped), like the message heatmap.
    getGuildVoiceHourlyHeatmap(guildId),
  ]);

  const leaders = await rangeLeaders(guild, from, to, {
    messages: sum(days, "messages"),
    voice: sum(days, "voiceMinutes"),
    commands: sum(days, "commands"),
  });

  return {
    scope: "server" as const,
    from,
    to,
    compareMode: compareRange ? query.compare : ("none" as const),
    bounds: { earliest, latest: today, maxSpanDays: MAX_SPAN_DAYS },
    days,
    hours,
    totals: distinct,
    voiceHeatmap,
    compare:
      compareRange && compareDays && compareDistinct
        ? {
            from: compareRange.from,
            to: compareRange.to,
            /** True when part of the comparison range is before tracking began. */
            partial: compareRange.from < earliest,
            days: compareDays,
            totals: compareDistinct,
          }
        : null,
    ...leaders,
  };
}
