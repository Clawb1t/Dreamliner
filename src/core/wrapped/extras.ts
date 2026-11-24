/**
 * The deeper half of Dreamliner Wrapped: message rhythm details, standings, new servers, store,
 * collecting, community counts, the month-by-month timeline and the overall personality. Same
 * rules as aggregate.ts: every query is narrowed to the one user and bounded to the year, and
 * anything empty comes back null so the slide is skipped. Moderation records (cases, warnings,
 * bans, appeals) are deliberately never read here.
 */
import type { Client } from "discord.js";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import {
  busiestWeek,
  longestGap,
  pickArchetype,
  quietestMonth,
  sharePercent,
  weekendShare,
  yearInWords,
  type Archetype,
  type ArchetypeInput,
} from "./summary.js";
import { yearBounds } from "./window.js";

type Row = Record<string, unknown>;
const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const all = <T extends Row>(query: SQL): T[] => getDb().all<T>(query);
const one = <T extends Row>(query: SQL): T | undefined => getDb().get<T>(query);

export type Standing = { rank: number; of: number; topPercent: number };

export type WrappedEvent = {
  date: string;
  kind: "first_message" | "busiest_day" | "streak_start" | "longest_voice" | "comeback" | "giveaway_won" | "set_completed" | "first_pack" | "quiz_best" | "new_server" | "starboard" | "first_play";
  value?: number;
  text?: string;
};

export type WrappedExtras = {
  rhythm: {
    busiestWeek: { start: string; messages: number } | null;
    busiestMonth: { month: number; messages: number } | null;
    quietestMonth: { month: number; messages: number } | null;
    weekendShare: number;
    averagePerActiveDay: number;
    longestGap: { days: number; comeback: string } | null;
    /** Days in the year so far (or the whole year once it's over). */
    daysSoFar: number;
  } | null;
  standings: {
    messages: Standing | null;
    voice: Standing | null;
    /** Your place in your home server's message board for the year. */
    home: (Standing & { server: string }) | null;
    /** Servers where you sent the most messages of anyone this year. */
    topMemberOf: Array<{ name: string; icon: string | null }>;
  } | null;
  servers: { newThisYear: Array<{ name: string; icon: string | null; firstDate: string }> } | null;
  voice: { deafenedSeconds: number; averageSessionSeconds: number; clipsAppearedIn: number } | null;
  emoji: {
    customShare: number;
    topReactions: Array<{ key: string; id: string | null; name: string; animated: boolean; count: number }>;
    customHome: { name: string; emoji: string; id: string; animated: boolean } | null;
  } | null;
  music: {
    topArtists: Array<{ name: string; plays: number }>;
    sources: Array<{ name: string; plays: number }>;
    busiestDay: { date: string; plays: number } | null;
    peakHour: number | null;
    personality: { key: string; label: string; line: string };
  } | null;
  hangar: {
    packsByType: Array<{ key: string; count: number }>;
    pulls: number;
    fleetValue: number;
    distinctCards: number;
    mythicsOwned: number;
    coinsSpent: number;
  } | null;
  store: { votes: number; creditsEarned: number; milesSpent: number; purchases: number; cosmeticsEquipped: number } | null;
  community: {
    suggestions: { made: number; implemented: number } | null;
    tickets: number;
    birthdays: number;
    customCommandRuns: number;
    quizPerfect: number;
    quizAverage: number | null;
    starsTotal: number;
  } | null;
  commands: { favouritePlugin: { name: string; uses: number } | null } | null;
  events: WrappedEvent[];
  archetype: Archetype;
  words: string[];
};

export type ExtrasContext = {
  client: Client;
  userId: string;
  year: number;
  now: Date;
  daily: Array<{ date: string; value: number }>;
  months: number[];
  voiceDaily: Array<{ date: string; seconds: number; sessions: number }>;
  hoursUtc: number[] | null;
  /** Everyone's message totals for the year (for standings). */
  messageTotals: number[];
  /** Everyone's voice seconds for the year. */
  voiceTotals: number[];
  messagesTotal: number;
  topServer: { id: string; name: string; share: number } | null;
  serverCount: number;
  longestStreak: { days: number; start: string } | null;
  busiest: { date: string; messages: number } | null;
  longestVoiceDay: { date: string; seconds: number } | null;
  emojiTotal: number;
  musicPlays: number;
  cardsCollected: number;
  communityCount: number;
  commandRows: Array<{ name: string; uses: number }>;
  /** Command name to plugin name (from the loaded commands), for "favourite plugin". */
  pluginOf?: (command: string) => string | undefined;
};

function standing(totals: readonly number[], mine: number, minPool = 3): Standing | null {
  if (mine <= 0 || totals.length < minPool) return null;
  let ahead = 0;
  for (const value of totals) if (value > mine) ahead += 1;
  return { rank: ahead + 1, of: totals.length, topPercent: Math.max(1, Math.ceil(((ahead + 1) / totals.length) * 100)) };
}

function guildInfo(client: Client, guildId: string): { name: string; icon: string | null } | null {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;
  return { name: guild.name, icon: guild.iconURL({ size: 128, extension: "png" }) ?? null };
}

/** Everyone's voice seconds for the year, for the voice standing. */
export function yearVoiceTotals(year: number): number[] {
  const { startDate, endDate } = yearBounds(year);
  return all<{ total: number }>(sql`
    SELECT SUM(seconds) AS total FROM guild_stats_user_voice_daily
    WHERE stat_date >= ${startDate} AND stat_date <= ${endDate}
    GROUP BY user_id HAVING total > 0
  `).map((row) => num(row.total));
}

const LISTENING: Record<string, { label: string; line: string }> = {
  repeat: { label: "The Repeat Listener", line: "When you find a good one, you really commit to it." },
  explorer: { label: "The Explorer", line: "Rarely the same track twice. The queue was a voyage of discovery." },
  night: { label: "The Late-Night Listener", line: "Headphones on, lights low, one more song." },
  loyal: { label: "The Superfan", line: "One artist did a lot of the heavy lifting this year." },
  balanced: { label: "The Easy Listener", line: "A bit of everything, nothing too serious. Lovely." },
};

export function listeningPersonality(input: { plays: number; distinct: number; topArtistPlays: number; peakHour: number | null }): { key: string; label: string; line: string } {
  const key =
    input.peakHour !== null && (input.peakHour >= 23 || input.peakHour <= 3)
      ? "night"
      : input.plays > 0 && input.topArtistPlays / input.plays >= 0.3
        ? "loyal"
        : input.distinct > 0 && input.plays / input.distinct >= 2.5
          ? "repeat"
          : input.plays > 0 && input.distinct / input.plays >= 0.8
            ? "explorer"
            : "balanced";
  return { key, ...LISTENING[key]! };
}

export function buildExtras(ctx: ExtrasContext): WrappedExtras {
  const { client, userId, year } = ctx;
  const b = yearBounds(year);
  const events: WrappedEvent[] = [];

  // --- Message rhythm ---------------------------------------------------------------------------
  const activeDates = ctx.daily.filter((d) => d.value > 0).map((d) => d.date);
  let rhythm: WrappedExtras["rhythm"] = null;
  if (ctx.messagesTotal > 0) {
    const week = busiestWeek(ctx.daily);
    const monthIdx = ctx.months.reduce((best, v, i, arr) => (v > (arr[best] ?? 0) ? i : best), 0);
    const quiet = quietestMonth(ctx.months);
    const gap = longestGap(activeDates);
    const endOfYear = Date.UTC(year + 1, 0, 1);
    const daysSoFar = Math.max(1, Math.round((Math.min(ctx.now.getTime(), endOfYear) - b.startMs) / 86_400_000));
    rhythm = {
      busiestWeek: week ? { start: week.start, messages: week.value } : null,
      busiestMonth: (ctx.months[monthIdx] ?? 0) > 0 ? { month: monthIdx, messages: ctx.months[monthIdx]! } : null,
      quietestMonth: quiet && quiet.month !== monthIdx ? { month: quiet.month, messages: quiet.value } : null,
      weekendShare: weekendShare(ctx.daily),
      averagePerActiveDay: Math.round(ctx.messagesTotal / Math.max(1, activeDates.length)),
      longestGap: gap && gap.days >= 3 ? gap : null,
      daysSoFar: Math.min(daysSoFar, Math.round((endOfYear - b.startMs) / 86_400_000)),
    };
    if (activeDates[0]) events.push({ date: activeDates[0], kind: "first_message" });
    if (gap && gap.days >= 7) events.push({ date: gap.comeback, kind: "comeback", value: gap.days });
  }
  if (ctx.busiest) events.push({ date: ctx.busiest.date, kind: "busiest_day", value: ctx.busiest.messages });
  if (ctx.longestStreak && ctx.longestStreak.days >= 3) events.push({ date: ctx.longestStreak.start, kind: "streak_start", value: ctx.longestStreak.days });
  if (ctx.longestVoiceDay && ctx.longestVoiceDay.seconds >= 1800) events.push({ date: ctx.longestVoiceDay.date, kind: "longest_voice", value: ctx.longestVoiceDay.seconds });

  // --- Standings --------------------------------------------------------------------------------
  const voiceSeconds = ctx.voiceDaily.reduce((s, d) => s + d.seconds, 0);
  let home: NonNullable<WrappedExtras["standings"]>["home"] = null;
  if (ctx.topServer) {
    const homeTotals = all<{ total: number }>(sql`
      SELECT SUM(messages) AS total FROM guild_stats_user_daily
      WHERE guild_id = ${ctx.topServer.id} AND stat_date >= ${b.startDate} AND stat_date <= ${b.endDate}
      GROUP BY user_id HAVING total > 0
    `).map((r) => num(r.total));
    const mine = one<{ total: number }>(sql`
      SELECT SUM(messages) AS total FROM guild_stats_user_daily
      WHERE guild_id = ${ctx.topServer.id} AND user_id = ${userId} AND stat_date >= ${b.startDate} AND stat_date <= ${b.endDate}
    `);
    const s = standing(homeTotals, num(mine?.total), 2);
    if (s) home = { ...s, server: ctx.topServer.name };
  }
  // Servers where nobody sent more messages than you this year (only servers you were active in).
  const topRows = all<{ guildId: string; mine: number; best: number }>(sql`
    WITH mine AS (
      SELECT guild_id, SUM(messages) AS total FROM guild_stats_user_daily
      WHERE user_id = ${userId} AND stat_date >= ${b.startDate} AND stat_date <= ${b.endDate}
      GROUP BY guild_id HAVING total >= 20
    )
    SELECT m.guild_id AS guildId, m.total AS mine, (
      SELECT MAX(t) FROM (
        SELECT SUM(d.messages) AS t FROM guild_stats_user_daily d
        WHERE d.guild_id = m.guild_id AND d.stat_date >= ${b.startDate} AND d.stat_date <= ${b.endDate}
        GROUP BY d.user_id
      )
    ) AS best
    FROM mine m
  `);
  const topMemberOf = topRows
    .filter((r) => num(r.mine) >= num(r.best))
    .map((r) => guildInfo(client, r.guildId))
    .filter((g): g is { name: string; icon: string | null } => Boolean(g))
    .slice(0, 6);
  const messagesStanding = standing(ctx.messageTotals, ctx.messagesTotal, 5);
  const voiceStanding = standing(ctx.voiceTotals, voiceSeconds, 3);
  const standings: WrappedExtras["standings"] = messagesStanding || voiceStanding || home || topMemberOf.length ? { messages: messagesStanding, voice: voiceStanding, home, topMemberOf } : null;

  // --- New servers ------------------------------------------------------------------------------
  const firsts = all<{ guildId: string; first: string }>(sql`
    SELECT guild_id AS guildId, MIN(stat_date) AS first FROM guild_stats_user_daily
    WHERE user_id = ${userId} GROUP BY guild_id HAVING first >= ${b.startDate} AND first <= ${b.endDate}
  `);
  const trackingStart = one<{ first: string | null }>(sql`SELECT MIN(stat_date) AS first FROM guild_stats_user_daily`)?.first ?? null;
  // Servers first seen on the day tracking began aren't "new", we just started counting.
  const newThisYear = firsts
    .filter((r) => r.first !== trackingStart)
    .map((r) => ({ ...guildInfo(client, r.guildId), firstDate: r.first }))
    .filter((g): g is { name: string; icon: string | null; firstDate: string } => typeof g.name === "string")
    .sort((a, b2) => a.firstDate.localeCompare(b2.firstDate));
  for (const g of newThisYear.slice(0, 4)) events.push({ date: g.firstDate, kind: "new_server", text: g.name });
  const servers: WrappedExtras["servers"] = newThisYear.length ? { newThisYear: newThisYear.slice(0, 8) } : null;

  // --- Voice extras -----------------------------------------------------------------------------
  const voiceRow = one<{ deaf: number; sessions: number; seconds: number }>(sql`
    SELECT SUM(deafened_seconds) AS deaf, SUM(sessions) AS sessions, SUM(seconds) AS seconds FROM guild_stats_user_voice_daily
    WHERE user_id = ${userId} AND stat_date >= ${b.startDate} AND stat_date <= ${b.endDate}
  `);
  const clipsIn = num(one<{ total: number }>(sql`
    SELECT COUNT(DISTINCT p.clip_id) AS total FROM voice_clip_participants p JOIN voice_clips c ON c.id = p.clip_id
    WHERE p.user_id = ${userId} AND c.deleted_at IS NULL AND c.created_at >= ${b.startSec} AND c.created_at < ${b.endSec}
  `)?.total);
  const voice: WrappedExtras["voice"] = num(voiceRow?.seconds) >= 60 || clipsIn > 0
    ? { deafenedSeconds: num(voiceRow?.deaf), averageSessionSeconds: num(voiceRow?.sessions) > 0 ? Math.round(num(voiceRow?.seconds) / num(voiceRow?.sessions)) : 0, clipsAppearedIn: clipsIn }
    : null;

  // --- Emoji extras -----------------------------------------------------------------------------
  let emoji: WrappedExtras["emoji"] = null;
  if (ctx.emojiTotal > 0) {
    const split = one<{ custom: number; total: number }>(sql`
      SELECT SUM(CASE WHEN emoji_id IS NOT NULL THEN message_count + reaction_count ELSE 0 END) AS custom,
        SUM(message_count + reaction_count) AS total
      FROM wrapped_emoji_usage WHERE user_id = ${userId} AND year = ${year}
    `);
    const reactions = all<{ key: string; id: string | null; name: string; animated: number; count: number }>(sql`
      SELECT emoji_key AS key, emoji_id AS id, name, animated, reaction_count AS count FROM wrapped_emoji_usage
      WHERE user_id = ${userId} AND year = ${year} AND reaction_count > 0 ORDER BY reaction_count DESC LIMIT 3
    `).map((r) => ({ ...r, animated: Boolean(r.animated), count: num(r.count) }));
    const topCustom = one<{ id: string; name: string; animated: number }>(sql`
      SELECT emoji_id AS id, name, animated FROM wrapped_emoji_usage
      WHERE user_id = ${userId} AND year = ${year} AND emoji_id IS NOT NULL ORDER BY (message_count + reaction_count) DESC LIMIT 1
    `);
    const homeGuild = topCustom ? client.emojis.cache.get(topCustom.id)?.guild : undefined;
    emoji = {
      customShare: sharePercent(num(split?.custom), num(split?.total)),
      topReactions: reactions,
      customHome: topCustom && homeGuild ? { name: homeGuild.name, emoji: topCustom.name, id: topCustom.id, animated: Boolean(topCustom.animated) } : null,
    };
  }

  // --- Music extras -----------------------------------------------------------------------------
  let music: WrappedExtras["music"] = null;
  if (ctx.musicPlays >= 5) {
    const artists = all<{ name: string; plays: number }>(sql`
      SELECT MAX(author) AS name, COUNT(*) AS plays FROM music_play_log
      WHERE user_id = ${userId} AND played_at >= ${b.startMs} AND played_at < ${b.endMs} AND author IS NOT NULL AND TRIM(author) != ''
      GROUP BY LOWER(TRIM(author)) ORDER BY plays DESC LIMIT 5
    `).map((r) => ({ name: r.name, plays: num(r.plays) }));
    const sources = all<{ name: string; plays: number }>(sql`
      SELECT COALESCE(source_name, 'other') AS name, COUNT(*) AS plays FROM music_play_log
      WHERE user_id = ${userId} AND played_at >= ${b.startMs} AND played_at < ${b.endMs}
      GROUP BY COALESCE(source_name, 'other') ORDER BY plays DESC LIMIT 4
    `).map((r) => ({ name: r.name, plays: num(r.plays) }));
    const day = one<{ date: string; plays: number }>(sql`
      SELECT strftime('%Y-%m-%d', played_at / 1000, 'unixepoch') AS date, COUNT(*) AS plays FROM music_play_log
      WHERE user_id = ${userId} AND played_at >= ${b.startMs} AND played_at < ${b.endMs}
      GROUP BY date ORDER BY plays DESC, date LIMIT 1
    `);
    const hour = one<{ hour: number }>(sql`
      SELECT CAST(strftime('%H', played_at / 1000, 'unixepoch') AS INTEGER) AS hour, COUNT(*) AS plays FROM music_play_log
      WHERE user_id = ${userId} AND played_at >= ${b.startMs} AND played_at < ${b.endMs}
      GROUP BY hour ORDER BY plays DESC LIMIT 1
    `);
    const distinct = num(one<{ total: number }>(sql`
      SELECT COUNT(DISTINCT COALESCE(uri, title)) AS total FROM music_play_log WHERE user_id = ${userId} AND played_at >= ${b.startMs} AND played_at < ${b.endMs}
    `)?.total);
    const first = one<{ playedAt: number; title: string }>(sql`
      SELECT played_at AS playedAt, title FROM music_play_log WHERE user_id = ${userId} AND played_at >= ${b.startMs} AND played_at < ${b.endMs} ORDER BY played_at LIMIT 1
    `);
    if (first) events.push({ date: new Date(num(first.playedAt)).toISOString().slice(0, 10), kind: "first_play", text: first.title });
    music = {
      topArtists: artists,
      sources,
      busiestDay: day ? { date: day.date, plays: num(day.plays) } : null,
      peakHour: hour ? num(hour.hour) : null,
      personality: listeningPersonality({ plays: ctx.musicPlays, distinct, topArtistPlays: artists[0]?.plays ?? 0, peakHour: hour ? num(hour.hour) : null }),
    };
  }

  // --- Hangar extras ----------------------------------------------------------------------------
  const packs = all<{ key: string; count: number; pulls: string; at: number }>(sql`
    SELECT COALESCE(pack_key, source) AS key, COUNT(*) AS count, '' AS pulls, MIN(created_at) AS at FROM plane_card_pack_openings
    WHERE user_id = ${userId} AND created_at >= ${b.startSec} AND created_at < ${b.endSec} GROUP BY COALESCE(pack_key, source) ORDER BY count DESC
  `);
  const pulls = num(one<{ total: number }>(sql`
    SELECT SUM(json_array_length(plane_type_ids)) AS total FROM plane_card_pack_openings
    WHERE user_id = ${userId} AND created_at >= ${b.startSec} AND created_at < ${b.endSec} AND json_valid(plane_type_ids)
  `)?.total);
  const state = one<{ fleet: number; distinctCards: number; mythics: number }>(sql`
    SELECT fleet_value AS fleet, distinct_cards AS distinctCards, mythics_owned AS mythics FROM plane_card_user_state WHERE user_id = ${userId}
  `);
  const coins = num(one<{ total: number }>(sql`
    SELECT -SUM(delta) AS total FROM plane_coin_ledger WHERE user_id = ${userId} AND delta < 0 AND created_at >= ${b.startSec} AND created_at < ${b.endSec}
  `)?.total);
  const firstPack = packs.reduce<number | null>((min, p) => (min === null || num(p.at) < min ? num(p.at) : min), null);
  if (firstPack) events.push({ date: new Date(firstPack * 1000).toISOString().slice(0, 10), kind: "first_pack" });
  for (const set of all<{ at: number }>(sql`
    SELECT completed_at AS at FROM plane_card_set_completions WHERE user_id = ${userId} AND completed_at >= ${b.startSec} AND completed_at < ${b.endSec} ORDER BY completed_at LIMIT 3
  `)) events.push({ date: new Date(num(set.at) * 1000).toISOString().slice(0, 10), kind: "set_completed" });
  const hangar: WrappedExtras["hangar"] = packs.length || state || coins
    ? {
        packsByType: packs.map((p) => ({ key: p.key, count: num(p.count) })),
        pulls,
        fleetValue: num(state?.fleet),
        distinctCards: num(state?.distinctCards),
        mythicsOwned: num(state?.mythics),
        coinsSpent: Math.round(coins),
      }
    : null;

  // --- Store (timestamps in ms) -----------------------------------------------------------------
  const votes = num(one<{ total: number }>(sql`SELECT COUNT(*) AS total FROM store_votes WHERE user_id = ${userId} AND voted_at >= ${b.startMs} AND voted_at < ${b.endMs}`)?.total);
  const credits = one<{ earned: number; miles: number }>(sql`
    SELECT SUM(CASE WHEN currency = 'credits' AND delta > 0 THEN delta ELSE 0 END) AS earned,
      SUM(CASE WHEN currency = 'miles' AND delta < 0 THEN -delta ELSE 0 END) AS miles
    FROM store_credit_ledger WHERE user_id = ${userId} AND created_at >= ${b.startMs} AND created_at < ${b.endMs}
  `);
  const purchases = num(one<{ total: number }>(sql`SELECT COUNT(*) AS total FROM store_entitlements WHERE user_id = ${userId} AND created_at >= ${b.startMs} AND created_at < ${b.endMs}`)?.total);
  const equipped = num(one<{ total: number }>(sql`SELECT COUNT(*) AS total FROM user_cosmetics_equipped WHERE user_id = ${userId}`)?.total);
  const store: WrappedExtras["store"] = votes + num(credits?.earned) + num(credits?.miles) + purchases > 0
    ? { votes, creditsEarned: num(credits?.earned), milesSpent: num(credits?.miles), purchases, cosmeticsEquipped: equipped }
    : null;

  // --- Community extras -------------------------------------------------------------------------
  const sugg = one<{ made: number; implemented: number }>(sql`
    SELECT COUNT(*) AS made, SUM(CASE WHEN implemented_at IS NOT NULL OR status = 'implemented' THEN 1 ELSE 0 END) AS implemented
    FROM suggestions WHERE author_id = ${userId} AND created_at >= ${b.startSec} AND created_at < ${b.endSec}
  `);
  const tickets = num(one<{ total: number }>(sql`SELECT COUNT(*) AS total FROM tickets WHERE opener_id = ${userId} AND created_at >= ${b.startSec} AND created_at < ${b.endSec}`)?.total);
  const birthdays = num(one<{ total: number }>(sql`SELECT COUNT(*) AS total FROM birthday_celebrations WHERE user_id = ${userId} AND year = ${year}`)?.total);
  const runs = num(one<{ total: number }>(sql`SELECT COUNT(*) AS total FROM dream_command_runs WHERE user_id = ${userId} AND started_at >= ${b.startMs} AND started_at < ${b.endMs}`)?.total);
  const quiz = one<{ perfect: number; avg: number | null; bestAt: number | null }>(sql`
    SELECT SUM(CASE WHEN percent >= 100 THEN 1 ELSE 0 END) AS perfect, AVG(percent) AS avg,
      (SELECT started_at FROM quiz_attempts q2 WHERE q2.user_id = ${userId} AND q2.status != 'in_progress' AND q2.started_at >= ${b.startMs} AND q2.started_at < ${b.endMs} ORDER BY percent DESC, started_at LIMIT 1) AS bestAt
    FROM quiz_attempts WHERE user_id = ${userId} AND status != 'in_progress' AND started_at >= ${b.startMs} AND started_at < ${b.endMs}
  `);
  if (quiz?.bestAt) events.push({ date: new Date(num(quiz.bestAt)).toISOString().slice(0, 10), kind: "quiz_best" });
  const stars = num(one<{ total: number }>(sql`SELECT SUM(star_count) AS total FROM starboard_posts WHERE author_id = ${userId} AND created_at >= ${b.startSec} AND created_at < ${b.endSec}`)?.total);
  const firstStar = one<{ at: number }>(sql`SELECT created_at AS at FROM starboard_posts WHERE author_id = ${userId} AND created_at >= ${b.startSec} AND created_at < ${b.endSec} ORDER BY star_count DESC LIMIT 1`);
  if (firstStar) events.push({ date: new Date(num(firstStar.at) * 1000).toISOString().slice(0, 10), kind: "starboard" });
  for (const win of all<{ at: number }>(sql`
    SELECT selected_at AS at FROM giveaway_winners WHERE user_id = ${userId} AND status != 'rerolled' AND selected_at >= ${b.startSec} AND selected_at < ${b.endSec} ORDER BY selected_at LIMIT 3
  `)) events.push({ date: new Date(num(win.at) * 1000).toISOString().slice(0, 10), kind: "giveaway_won" });
  const communityFilled = num(sugg?.made) + tickets + birthdays + runs + stars + num(quiz?.perfect) > 0;
  const community: WrappedExtras["community"] = communityFilled
    ? {
        suggestions: num(sugg?.made) > 0 ? { made: num(sugg?.made), implemented: num(sugg?.implemented) } : null,
        tickets,
        birthdays,
        customCommandRuns: runs,
        quizPerfect: num(quiz?.perfect),
        quizAverage: quiz?.avg == null ? null : Math.round(num(quiz.avg)),
        starsTotal: stars,
      }
    : null;

  // --- Commands: favourite plugin ---------------------------------------------------------------
  let commands: WrappedExtras["commands"] = null;
  if (ctx.commandRows.length && ctx.pluginOf) {
    const byPlugin = new Map<string, number>();
    for (const row of ctx.commandRows) {
      const plugin = ctx.pluginOf(row.name);
      if (plugin) byPlugin.set(plugin, (byPlugin.get(plugin) ?? 0) + row.uses);
    }
    const best = [...byPlugin].sort((a, b2) => b2[1] - a[1])[0];
    commands = { favouritePlugin: best ? { name: best[0], uses: best[1] } : null };
  }

  // --- Personality ------------------------------------------------------------------------------
  const hours = ctx.hoursUtc ?? [];
  const hourTotal = hours.reduce((a, v) => a + v, 0);
  const night = hourTotal ? [23, 0, 1, 2, 3, 4].reduce((a, h) => a + (hours[h] ?? 0), 0) / hourTotal : 0;
  const input: ArchetypeInput = {
    messages: ctx.messagesTotal,
    activeDays: activeDates.length,
    voiceHours: voiceSeconds / 3600,
    nightShare: night,
    servers: ctx.serverCount,
    cards: ctx.cardsCollected,
    musicPlays: ctx.musicPlays,
    emoji: ctx.emojiTotal,
    community: ctx.communityCount + num(sugg?.made),
    longestStreak: ctx.longestStreak?.days ?? 0,
    topShare: ctx.topServer?.share ?? 0,
  };

  events.sort((a, b2) => a.date.localeCompare(b2.date));
  return {
    rhythm,
    standings,
    servers,
    voice,
    emoji,
    music,
    hangar,
    store,
    community,
    commands,
    events: events.filter((e) => e.date >= b.startDate && e.date <= b.endDate).slice(0, 24),
    archetype: pickArchetype(input),
    words: yearInWords(input),
  };
}
