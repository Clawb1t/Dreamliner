/**
 * Builds one person's Dreamliner Wrapped for a calendar year (UTC). Only ever shown to that person
 * (viewer === subject), so Ghost Mode doesn't hide anything here; the cross-server readers are still
 * used for the global tables, with the subject as the viewer. Every query is narrowed to the user and
 * bounded to the year, and each section is null when there's nothing to show, so the website can
 * skip that slide rather than show zeros.
 *
 * The bridge serves this from a per-user cache (webWrapped.ts), so the queries run at most about
 * once an hour per person.
 */
import type { Client } from "discord.js";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { globalEconomyFor, hourlyActivityFor } from "../privacy/crossServer.js";
import { getProgressionBadges } from "../progressionBadges/index.js";
import { RARITIES } from "../../plugins/economy/hangar/constants.js";
import { flushCommandUsage } from "./commands.js";
import { flushEmojiUsage } from "./emoji.js";
import { busiestDay, longestStreak, monthlyTotals, sharePercent, topPercent, weekdayTotals, yearHeatmap, type Streak } from "./summary.js";
import { yearBounds } from "./window.js";

/** Music slides need at least this many plays. */
export const MIN_MUSIC_PLAYS = 5;

export type WrappedServer = { id: string; name: string; icon: string | null; messages: number; share: number };

export type WrappedPayload = {
  year: number;
  generatedAt: string;
  /** First day anything was recorded that year (anyone's), when it's after 1 January. */
  trackingSince: string | null;
  user: { id: string; name: string; username: string | null; avatar: string | null };
  messages: {
    total: number;
    activeDays: number;
    /** "Top X%" of everyone with messages that year, or null when the pool is too small. */
    topPercent: number | null;
    /** How many people had messages that year. */
    pool: number;
    firstDate: string;
    /** One character per day of the year, "0" (none) to "4" (busiest quarter of their days). */
    heatmap: string;
  } | null;
  servers: { count: number; top: WrappedServer[] } | null;
  voice: {
    seconds: number;
    sessions: number;
    streamingSeconds: number;
    mutedSeconds: number;
    activeDays: number;
    longestDay: { date: string; seconds: number } | null;
    topServer: { id: string; name: string; icon: string | null; seconds: number } | null;
  } | null;
  /** Lifetime messages per UTC hour (0-23); the site shifts it into the viewer's own time zone. */
  hours: number[] | null;
  /** Messages per weekday this year, Monday first. */
  weekdays: number[] | null;
  rhythm: { months: number[]; busiestDay: { date: string; messages: number } } | null;
  streaks: { longest: Streak | null; daily: number | null } | null;
  emoji: {
    total: number;
    reactions: number;
    distinct: number;
    top: Array<{ key: string; id: string | null; name: string; animated: boolean; count: number }>;
  } | null;
  music: {
    plays: number;
    minutes: number;
    distinctTracks: number;
    topTracks: Array<{ title: string; author: string | null; uri: string | null; artwork: string | null; plays: number }>;
    topArtist: { name: string; plays: number } | null;
    topServer: { name: string; plays: number } | null;
  } | null;
  hangar: {
    collected: number;
    packs: number;
    flights: number;
    trades: number;
    sales: number;
    sets: number;
    rarities: Record<string, number>;
    rarest: { name: string; rarity: string; serial: number; livery: string } | null;
  } | null;
  economy: { balance: number; dailyStreak: number; spentOnPacks: number; earnedFromSales: number } | null;
  community: {
    quizzes: { taken: number; bestPercent: number | null } | null;
    liveQuizzes: { games: number; bestScore: number } | null;
    giveaways: { entered: number; won: number } | null;
    starboard: { posts: number; topStars: number } | null;
    invites: number;
    clips: number;
    rewards: number;
  } | null;
  commands: { total: number; distinct: number; top: Array<{ name: string; uses: number }> } | null;
  badges: Array<{ id: string; name: string; tierName: string | null; imageKey: string; imageVersion: string; since: string | null }> | null;
};

type Row = Record<string, unknown>;
const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

function all<T extends Row>(query: SQL): T[] {
  return getDb().all<T>(query);
}

function one<T extends Row>(query: SQL): T | undefined {
  return getDb().get<T>(query);
}

function guildInfo(client: Client, guildId: string): { name: string; icon: string | null } | null {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;
  return { name: guild.name, icon: guild.iconURL({ size: 128, extension: "png" }) ?? null };
}

/** Everyone's message totals for the year, for the "top X%" line. Shared by every user's build. */
export function yearMessageTotals(year: number): number[] {
  const { startDate, endDate } = yearBounds(year);
  return all<{ total: number }>(sql`
    SELECT SUM(messages) AS total FROM guild_stats_user_daily
    WHERE stat_date >= ${startDate} AND stat_date <= ${endDate}
    GROUP BY user_id HAVING total > 0
  `).map((row) => num(row.total));
}

export type BuildWrappedOptions = {
  /** Supplies everyone's year totals (cached by the caller). Defaults to a fresh query. */
  yearTotals?: (year: number) => Promise<number[]> | number[];
  now?: Date;
};

export async function buildWrapped(client: Client, userId: string, year: number, options: BuildWrappedOptions = {}): Promise<WrappedPayload> {
  // Batched counters: write anything still in memory so the numbers include the last few seconds.
  flushEmojiUsage();
  flushCommandUsage();

  const now = options.now ?? new Date();
  const b = yearBounds(year);

  // --- Identity -------------------------------------------------------------------------------
  const discordUser = await client.users.fetch(userId).catch(() => null);
  const user = {
    id: userId,
    name: discordUser?.globalName ?? discordUser?.username ?? "You",
    username: discordUser?.username ?? null,
    avatar: discordUser?.displayAvatarURL({ size: 256, extension: "png" }) ?? null,
  };

  const firstTracked = one<{ first: string | null }>(sql`
    SELECT MIN(stat_date) AS first FROM guild_stats_user_daily WHERE stat_date >= ${b.startDate} AND stat_date <= ${b.endDate}
  `)?.first ?? null;
  const trackingSince = firstTracked && firstTracked > b.startDate ? firstTracked : null;

  // --- Messages, servers, rhythm ---------------------------------------------------------------
  const daily = all<{ date: string; messages: number }>(sql`
    SELECT stat_date AS date, SUM(messages) AS messages FROM guild_stats_user_daily
    WHERE user_id = ${userId} AND stat_date >= ${b.startDate} AND stat_date <= ${b.endDate}
    GROUP BY stat_date ORDER BY stat_date
  `).map((row) => ({ date: row.date, value: num(row.messages) }));
  const totalMessages = daily.reduce((sum, row) => sum + row.value, 0);
  const activeMessageDays = daily.filter((row) => row.value > 0);

  let messages: WrappedPayload["messages"] = null;
  if (totalMessages > 0) {
    const totals = options.yearTotals ? await options.yearTotals(year) : yearMessageTotals(year);
    messages = {
      total: totalMessages,
      activeDays: activeMessageDays.length,
      topPercent: topPercent(totals, totalMessages),
      pool: totals.length,
      firstDate: activeMessageDays[0]!.date,
      heatmap: yearHeatmap(year, daily),
    };
  }

  const perGuild = all<{ guildId: string; messages: number }>(sql`
    SELECT guild_id AS guildId, SUM(messages) AS messages FROM guild_stats_user_daily
    WHERE user_id = ${userId} AND stat_date >= ${b.startDate} AND stat_date <= ${b.endDate}
    GROUP BY guild_id HAVING messages > 0 ORDER BY messages DESC
  `);
  let servers: WrappedPayload["servers"] = null;
  if (perGuild.length > 0) {
    const top: WrappedServer[] = [];
    for (const row of perGuild) {
      const info = guildInfo(client, row.guildId);
      if (!info) continue; // A server Dreamliner has since left: counted, not named.
      top.push({ id: row.guildId, ...info, messages: num(row.messages), share: sharePercent(num(row.messages), totalMessages) });
      if (top.length === 5) break;
    }
    if (top.length > 0) servers = { count: perGuild.length, top };
  }

  const best = busiestDay(daily);
  const rhythm: WrappedPayload["rhythm"] = best ? { months: monthlyTotals(daily), busiestDay: { date: best.date, messages: best.value } } : null;
  const weekdays = totalMessages > 0 ? weekdayTotals(daily) : null;

  const hourly = hourlyActivityFor(userId, userId, now);
  const hours = hourly.hours.some((value) => value > 0) ? hourly.hours : null;

  // --- Voice ------------------------------------------------------------------------------------
  const voiceDaily = all<{ date: string; seconds: number; sessions: number; streaming: number; muted: number }>(sql`
    SELECT stat_date AS date, SUM(seconds) AS seconds, SUM(sessions) AS sessions,
      SUM(streaming_seconds) AS streaming, SUM(muted_seconds) AS muted
    FROM guild_stats_user_voice_daily
    WHERE user_id = ${userId} AND stat_date >= ${b.startDate} AND stat_date <= ${b.endDate}
    GROUP BY stat_date
  `);
  const voiceSeconds = voiceDaily.reduce((sum, row) => sum + num(row.seconds), 0);
  let voice: WrappedPayload["voice"] = null;
  if (voiceSeconds >= 60) {
    const longest = voiceDaily.reduce<{ date: string; seconds: number } | null>(
      (top, row) => (!top || num(row.seconds) > top.seconds ? { date: row.date, seconds: num(row.seconds) } : top),
      null,
    );
    const voiceGuilds = all<{ guildId: string; seconds: number }>(sql`
      SELECT guild_id AS guildId, SUM(seconds) AS seconds FROM guild_stats_user_voice_daily
      WHERE user_id = ${userId} AND stat_date >= ${b.startDate} AND stat_date <= ${b.endDate}
      GROUP BY guild_id ORDER BY seconds DESC LIMIT 10
    `);
    let topServer: NonNullable<WrappedPayload["voice"]>["topServer"] = null;
    for (const row of voiceGuilds) {
      const info = guildInfo(client, row.guildId);
      if (info) {
        topServer = { id: row.guildId, ...info, seconds: num(row.seconds) };
        break;
      }
    }
    voice = {
      seconds: voiceSeconds,
      sessions: voiceDaily.reduce((sum, row) => sum + num(row.sessions), 0),
      streamingSeconds: voiceDaily.reduce((sum, row) => sum + num(row.streaming), 0),
      mutedSeconds: voiceDaily.reduce((sum, row) => sum + num(row.muted), 0),
      activeDays: voiceDaily.filter((row) => num(row.seconds) > 0).length,
      longestDay: longest,
      topServer,
    };
  }

  // --- Streaks ----------------------------------------------------------------------------------
  const activeDates = [...activeMessageDays.map((row) => row.date), ...voiceDaily.filter((row) => num(row.seconds) > 0).map((row) => row.date)];
  const longest = longestStreak(activeDates);
  const economyNow = globalEconomyFor(userId, userId, now);
  const dailyStreak = economyNow && economyNow.streak > 0 ? economyNow.streak : null;
  const streaks: WrappedPayload["streaks"] = (longest && longest.days >= 2) || dailyStreak ? { longest: longest && longest.days >= 2 ? longest : null, daily: dailyStreak } : null;

  // --- Emoji ------------------------------------------------------------------------------------
  const emojiRows = all<{ key: string; id: string | null; name: string; animated: number; messages: number; reactions: number }>(sql`
    SELECT emoji_key AS key, emoji_id AS id, name, animated, message_count AS messages, reaction_count AS reactions
    FROM wrapped_emoji_usage WHERE user_id = ${userId} AND year = ${year}
    ORDER BY (message_count + reaction_count) DESC LIMIT 200
  `);
  const emojiTotal = emojiRows.reduce((sum, row) => sum + num(row.messages) + num(row.reactions), 0);
  const emoji: WrappedPayload["emoji"] = emojiTotal > 0
    ? {
        total: emojiTotal,
        reactions: emojiRows.reduce((sum, row) => sum + num(row.reactions), 0),
        distinct: num(one<{ total: number }>(sql`SELECT COUNT(*) AS total FROM wrapped_emoji_usage WHERE user_id = ${userId} AND year = ${year}`)?.total),
        top: emojiRows.slice(0, 5).map((row) => ({
          key: row.key,
          id: row.id,
          name: row.name,
          animated: Boolean(row.animated),
          count: num(row.messages) + num(row.reactions),
        })),
      }
    : null;

  // --- Music ------------------------------------------------------------------------------------
  const musicTotals = one<{ plays: number; ms: number; tracks: number }>(sql`
    SELECT COUNT(*) AS plays, SUM(duration_ms) AS ms, COUNT(DISTINCT COALESCE(uri, title)) AS tracks
    FROM music_play_log WHERE user_id = ${userId} AND played_at >= ${b.startMs} AND played_at < ${b.endMs}
  `);
  let music: WrappedPayload["music"] = null;
  if (num(musicTotals?.plays) >= MIN_MUSIC_PLAYS) {
    const topTracks = all<{ title: string; author: string | null; uri: string | null; artwork: string | null; plays: number }>(sql`
      SELECT MAX(title) AS title, MAX(author) AS author, MAX(uri) AS uri, MAX(artwork_url) AS artwork, COUNT(*) AS plays
      FROM music_play_log WHERE user_id = ${userId} AND played_at >= ${b.startMs} AND played_at < ${b.endMs}
      GROUP BY COALESCE(uri, LOWER(title) || '|' || LOWER(COALESCE(author, '')))
      ORDER BY plays DESC, MAX(played_at) DESC LIMIT 5
    `).map((row) => ({ ...row, plays: num(row.plays) }));
    const artist = one<{ name: string; plays: number }>(sql`
      SELECT MAX(author) AS name, COUNT(*) AS plays FROM music_play_log
      WHERE user_id = ${userId} AND played_at >= ${b.startMs} AND played_at < ${b.endMs} AND author IS NOT NULL AND TRIM(author) != ''
      GROUP BY LOWER(TRIM(author)) ORDER BY plays DESC LIMIT 1
    `);
    const musicGuilds = all<{ guildId: string; plays: number }>(sql`
      SELECT guild_id AS guildId, COUNT(*) AS plays FROM music_play_log
      WHERE user_id = ${userId} AND played_at >= ${b.startMs} AND played_at < ${b.endMs}
      GROUP BY guild_id ORDER BY plays DESC LIMIT 5
    `);
    let topServer: { name: string; plays: number } | null = null;
    for (const row of musicGuilds) {
      const info = guildInfo(client, row.guildId);
      if (info) {
        topServer = { name: info.name, plays: num(row.plays) };
        break;
      }
    }
    music = {
      plays: num(musicTotals?.plays),
      minutes: Math.round(num(musicTotals?.ms) / 60_000),
      distinctTracks: num(musicTotals?.tracks),
      topTracks,
      topArtist: artist?.name ? { name: artist.name, plays: num(artist.plays) } : null,
      topServer,
    };
  }

  // --- The Hangar (timestamps in seconds) -------------------------------------------------------
  const copies = all<{ name: string; rarity: string; serial: number; livery: string }>(sql`
    SELECT t.name AS name, t.rarity AS rarity, c.serial AS serial, c.livery AS livery
    FROM plane_card_copies c JOIN plane_card_types t ON t.id = c.card_type_id
    WHERE c.owner_id = ${userId} AND c.acquired_at >= ${b.startSec} AND c.acquired_at < ${b.endSec}
  `);
  const packs = one<{ total: number; spent: number }>(sql`
    SELECT COUNT(*) AS total, SUM(cost) AS spent FROM plane_card_pack_openings
    WHERE user_id = ${userId} AND created_at >= ${b.startSec} AND created_at < ${b.endSec}
  `);
  const flights = num(one<{ total: number }>(sql`
    SELECT COUNT(*) AS total FROM plane_card_flights WHERE user_id = ${userId} AND started_at >= ${b.startSec} AND started_at < ${b.endSec}
  `)?.total);
  const trades = num(one<{ total: number }>(sql`
    SELECT COUNT(*) AS total FROM plane_card_trades
    WHERE (from_user_id = ${userId} OR to_user_id = ${userId}) AND status = 'accepted' AND resolved_at >= ${b.startSec} AND resolved_at < ${b.endSec}
  `)?.total);
  const sales = one<{ total: number; earned: number }>(sql`
    SELECT COUNT(*) AS total, SUM(price - COALESCE(fee, 0)) AS earned FROM plane_card_listings
    WHERE seller_id = ${userId} AND status = 'sold' AND resolved_at >= ${b.startSec} AND resolved_at < ${b.endSec}
  `);
  const sets = num(one<{ total: number }>(sql`
    SELECT COUNT(*) AS total FROM plane_card_set_completions WHERE user_id = ${userId} AND completed_at >= ${b.startSec} AND completed_at < ${b.endSec}
  `)?.total);
  let hangar: WrappedPayload["hangar"] = null;
  if (copies.length + num(packs?.total) + flights + trades + sets > 0) {
    const rarities: Record<string, number> = {};
    for (const copy of copies) rarities[copy.rarity] = (rarities[copy.rarity] ?? 0) + 1;
    const rank = (rarity: string) => (RARITIES as readonly string[]).indexOf(rarity);
    const rarest = copies.reduce<(typeof copies)[number] | null>(
      (top, copy) => (!top || rank(copy.rarity) > rank(top.rarity) || (rank(copy.rarity) === rank(top.rarity) && num(copy.serial) < num(top.serial)) ? copy : top),
      null,
    );
    hangar = {
      collected: copies.length,
      packs: num(packs?.total),
      flights,
      trades,
      sales: num(sales?.total),
      sets,
      rarities,
      rarest: rarest ? { name: rarest.name, rarity: rarest.rarity, serial: num(rarest.serial), livery: rarest.livery } : null,
    };
  }

  // --- Economy ----------------------------------------------------------------------------------
  const balance = economyNow?.balance ?? 0;
  const spentOnPacks = Math.round(num(packs?.spent));
  const earnedFromSales = Math.round(num(sales?.earned));
  const economy: WrappedPayload["economy"] = balance > 0 || spentOnPacks > 0 || earnedFromSales > 0 || (economyNow?.streak ?? 0) > 0
    ? { balance: Math.round(balance), dailyStreak: economyNow?.streak ?? 0, spentOnPacks, earnedFromSales }
    : null;

  // --- Community --------------------------------------------------------------------------------
  const quizRow = one<{ taken: number; best: number | null }>(sql`
    SELECT COUNT(*) AS taken, MAX(percent) AS best FROM quiz_attempts
    WHERE user_id = ${userId} AND status != 'in_progress' AND started_at >= ${b.startMs} AND started_at < ${b.endMs}
  `);
  const liveRow = one<{ games: number; best: number }>(sql`
    SELECT COUNT(*) AS games, MAX(score) AS best FROM quiz_live_players
    WHERE user_id = ${userId} AND joined_at >= ${b.startMs} AND joined_at < ${b.endMs}
  `);
  const entered = num(one<{ total: number }>(sql`
    SELECT COUNT(*) AS total FROM giveaway_entries WHERE user_id = ${userId} AND entered_at >= ${b.startSec} AND entered_at < ${b.endSec}
  `)?.total);
  const won = num(one<{ total: number }>(sql`
    SELECT COUNT(*) AS total FROM giveaway_winners WHERE user_id = ${userId} AND status != 'rerolled' AND selected_at >= ${b.startSec} AND selected_at < ${b.endSec}
  `)?.total);
  const starRow = one<{ posts: number; top: number }>(sql`
    SELECT COUNT(*) AS posts, MAX(star_count) AS top FROM starboard_posts
    WHERE author_id = ${userId} AND created_at >= ${b.startSec} AND created_at < ${b.endSec}
  `);
  const invites = num(one<{ total: number }>(sql`
    SELECT COUNT(*) AS total FROM invite_joins
    WHERE inviter_id = ${userId} AND counted = 1 AND joined_at >= ${b.startSec} AND joined_at < ${b.endSec}
  `)?.total);
  const clips = num(one<{ total: number }>(sql`
    SELECT COUNT(*) AS total FROM voice_clips WHERE owner_id = ${userId} AND deleted_at IS NULL AND created_at >= ${b.startSec} AND created_at < ${b.endSec}
  `)?.total);
  const rewards = num(one<{ total: number }>(sql`
    SELECT COUNT(*) AS total FROM activity_rewards_awarded WHERE user_id = ${userId} AND awarded_at >= ${b.startSec} AND awarded_at < ${b.endSec}
  `)?.total);
  const community: NonNullable<WrappedPayload["community"]> = {
    quizzes: num(quizRow?.taken) > 0 ? { taken: num(quizRow?.taken), bestPercent: quizRow?.best == null ? null : Math.round(num(quizRow.best)) } : null,
    liveQuizzes: num(liveRow?.games) > 0 ? { games: num(liveRow?.games), bestScore: num(liveRow?.best) } : null,
    giveaways: entered + won > 0 ? { entered, won } : null,
    starboard: num(starRow?.posts) > 0 ? { posts: num(starRow?.posts), topStars: num(starRow?.top) } : null,
    invites,
    clips,
    rewards,
  };
  const communityFilled = [community.quizzes, community.liveQuizzes, community.giveaways, community.starboard].filter(Boolean).length + [invites, clips, rewards].filter((n) => n > 0).length;

  // --- Commands ---------------------------------------------------------------------------------
  const commandRows = all<{ name: string; uses: number }>(sql`
    SELECT command_name AS name, uses FROM wrapped_command_usage WHERE user_id = ${userId} AND year = ${year} ORDER BY uses DESC, command_name
  `);
  const commandTotal = commandRows.reduce((sum, row) => sum + num(row.uses), 0);
  const commands: WrappedPayload["commands"] = commandTotal > 0
    ? { total: commandTotal, distinct: commandRows.length, top: commandRows.slice(0, 5).map((row) => ({ name: row.name, uses: num(row.uses) })) }
    : null;

  // --- Badges -----------------------------------------------------------------------------------
  const allBadges = await getProgressionBadges(client, userId).catch(() => []);
  const thisYear = allBadges.filter((badge) => !badge.since || (badge.since >= b.startDate && badge.since < `${year + 1}-01-01`));
  const badges: WrappedPayload["badges"] = thisYear.length
    ? thisYear.slice(0, 8).map((badge) => ({
        id: badge.id,
        name: badge.name,
        tierName: badge.tierName,
        imageKey: badge.imageKey,
        imageVersion: badge.imageVersion,
        since: badge.since,
      }))
    : null;

  return {
    year,
    generatedAt: now.toISOString(),
    trackingSince,
    user,
    messages,
    servers,
    voice,
    hours,
    weekdays,
    rhythm,
    streaks,
    emoji,
    music,
    hangar,
    economy,
    community: communityFilled > 0 ? community : null,
    commands,
    badges,
  };
}
