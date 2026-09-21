import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Client, VoiceState } from "discord.js";
import { getDb } from "../../../db/client.js";
import {
  guildStatsChannelVoiceDaily,
  guildStatsUserVoiceDaily,
  guildStatsVoiceDaily,
} from "../../../db/schema.js";
import { getLogger } from "../../../core/logger.js";
import { dateRange, isAllTimeWindow, resolveFilledWindow, statDate } from "./daily.js";

const log = getLogger("stats:voice");

type ActiveSession = { guildId: string; channelId: string; joinedAt: number };

/**
 * In-memory only, intentionally not persisted: a session that's mid-flight when the process
 * restarts just loses its start time, not any already-flushed minutes. `snapshotActiveVoiceMembers`
 * re-seeds this map on boot from whoever is actually in a voice channel at that moment (see below).
 */
const activeSessions = new Map<string, ActiveSession>();

async function incrementVoiceDailyStat(guildId: string, minutes: number): Promise<void> {
  const db = getDb();
  const date = statDate();
  await db
    .insert(guildStatsVoiceDaily)
    .values({ guildId, statDate: date, minutes })
    .onConflictDoUpdate({
      target: [guildStatsVoiceDaily.guildId, guildStatsVoiceDaily.statDate],
      set: { minutes: sql`${guildStatsVoiceDaily.minutes} + ${minutes}` },
    });
}

async function incrementUserVoiceDailyStat(guildId: string, userId: string, minutes: number): Promise<void> {
  const db = getDb();
  const date = statDate();
  await db
    .insert(guildStatsUserVoiceDaily)
    .values({ guildId, userId, statDate: date, minutes })
    .onConflictDoUpdate({
      target: [guildStatsUserVoiceDaily.guildId, guildStatsUserVoiceDaily.userId, guildStatsUserVoiceDaily.statDate],
      set: { minutes: sql`${guildStatsUserVoiceDaily.minutes} + ${minutes}` },
    });
}

async function incrementChannelVoiceDailyStat(guildId: string, channelId: string, minutes: number): Promise<void> {
  const db = getDb();
  const date = statDate();
  await db
    .insert(guildStatsChannelVoiceDaily)
    .values({ guildId, channelId, statDate: date, minutes })
    .onConflictDoUpdate({
      target: [
        guildStatsChannelVoiceDaily.guildId,
        guildStatsChannelVoiceDaily.channelId,
        guildStatsChannelVoiceDaily.statDate,
      ],
      set: { minutes: sql`${guildStatsChannelVoiceDaily.minutes} + ${minutes}` },
    });
}

/** Flushes a tracked session's elapsed time into all three voice tables, crediting it entirely to
 *  today's stat date. Deliberate simplification: a session spanning midnight UTC is credited
 *  entirely to the day it ends on, not split across the boundary. Never throws. */
async function flushSession(userId: string): Promise<void> {
  const session = activeSessions.get(userId);
  if (!session) return;
  activeSessions.delete(userId);

  const minutes = Math.round((Date.now() - session.joinedAt) / 60_000);
  if (minutes <= 0) return;

  try {
    await Promise.all([
      incrementVoiceDailyStat(session.guildId, minutes),
      incrementUserVoiceDailyStat(session.guildId, userId, minutes),
      incrementChannelVoiceDailyStat(session.guildId, session.channelId, minutes),
    ]);
  } catch (err) {
    log.error(`Failed to flush voice session for user ${userId} in guild ${session.guildId}:`, err);
  }
}

function startSession(userId: string, guildId: string, channelId: string): void {
  activeSessions.set(userId, { guildId, channelId, joinedAt: Date.now() });
}

/** Wired to discord.js's VoiceStateUpdate event in the stats plugin. Best-effort: guarded so a
 *  bug here never breaks voice-state handling for the rest of the guild. */
export async function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
  try {
    const member = newState.member ?? oldState.member;
    if (member?.user.bot) return;

    const userId = newState.id;
    const guildId = newState.guild.id;
    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    if (oldChannelId === newChannelId) return; // mute/deafen/etc, no channel change

    if (newChannelId === null) {
      // Left voice entirely.
      await flushSession(userId);
      return;
    }

    // Newly joined, or switched channels: flush whatever was tracked before, then start fresh.
    await flushSession(userId);
    startSession(userId, guildId, newChannelId);
  } catch (err) {
    log.error("handleVoiceStateUpdate failed:", err);
  }
}

/**
 * Called once on plugin boot to recover from a restart: anyone already sitting in a voice channel
 * has no session tracked yet (the join happened before this process existed), so this seeds one
 * for each of them, starting the clock from right now. This deliberately does not try to
 * reconstruct how long they'd already been in voice before the restart, an accepted limitation
 * for a best-effort analytics feature, not moderation-critical infrastructure.
 *
 * `isGuildEnabled` lets the caller skip guilds that don't have voice tracking turned on, matching
 * the same gate the VoiceStateUpdate handler applies, so a restart never seeds sessions for a
 * guild that opted out.
 */
export async function snapshotActiveVoiceMembers(
  client: Client,
  isGuildEnabled: (guildId: string) => Promise<boolean>,
): Promise<void> {
  try {
    for (const guild of client.guilds.cache.values()) {
      if (!(await isGuildEnabled(guild.id))) continue;
      for (const channel of guild.channels.cache.values()) {
        if (!channel.isVoiceBased()) continue;
        for (const member of channel.members.values()) {
          if (member.user.bot) continue;
          if (activeSessions.has(member.id)) continue;
          startSession(member.id, guild.id, channel.id);
        }
      }
    }
  } catch (err) {
    log.error("snapshotActiveVoiceMembers failed:", err);
  }
}

export type VoiceDailyRow = { statDate: string; minutes: number };

/** Zero-filled minutes-per-day series, mirrors getFilledDailyStats in daily.ts. */
export async function getFilledVoiceDailyStats(guildId: string, days: number = 14): Promise<VoiceDailyRow[]> {
  const db = getDb();

  if (isAllTimeWindow(days)) {
    const rows = await db
      .select()
      .from(guildStatsVoiceDaily)
      .where(eq(guildStatsVoiceDaily.guildId, guildId));
    const dates = resolveFilledWindow(days, rows.map((row) => row.statDate));
    const byDate = new Map(rows.map((row) => [row.statDate, row.minutes]));
    return dates.map((date) => ({ statDate: date, minutes: byDate.get(date) ?? 0 }));
  }

  const dates = dateRange(days);
  const since = dates[0]!;
  const rows = await db
    .select()
    .from(guildStatsVoiceDaily)
    .where(and(eq(guildStatsVoiceDaily.guildId, guildId), gte(guildStatsVoiceDaily.statDate, since)));

  const byDate = new Map(rows.map((row) => [row.statDate, row.minutes]));
  return dates.map((date) => ({ statDate: date, minutes: byDate.get(date) ?? 0 }));
}

/** Top voice channels by summed minutes over the window (or all time). */
export async function getTopVoiceChannels(
  guildId: string,
  days: number = 14,
  limit = 5,
): Promise<{ channelId: string; minutes: number }[]> {
  const db = getDb();
  const since = windowSinceTimestampForStatDate(days);
  const filters = [eq(guildStatsChannelVoiceDaily.guildId, guildId)];
  if (since) filters.push(gte(guildStatsChannelVoiceDaily.statDate, since));

  const rows = await db
    .select({
      channelId: guildStatsChannelVoiceDaily.channelId,
      minutes: sql<number>`coalesce(sum(${guildStatsChannelVoiceDaily.minutes}), 0)`,
    })
    .from(guildStatsChannelVoiceDaily)
    .where(and(...filters))
    .groupBy(guildStatsChannelVoiceDaily.channelId)
    .orderBy(desc(sql`coalesce(sum(${guildStatsChannelVoiceDaily.minutes}), 0)`))
    .limit(limit);

  return rows;
}

/** Top voice users by summed minutes over the window (or all time). */
export async function getTopVoiceUsers(
  guildId: string,
  days: number = 14,
  limit = 5,
): Promise<{ userId: string; minutes: number }[]> {
  const db = getDb();
  const since = windowSinceTimestampForStatDate(days);
  const filters = [eq(guildStatsUserVoiceDaily.guildId, guildId)];
  if (since) filters.push(gte(guildStatsUserVoiceDaily.statDate, since));

  const rows = await db
    .select({
      userId: guildStatsUserVoiceDaily.userId,
      minutes: sql<number>`coalesce(sum(${guildStatsUserVoiceDaily.minutes}), 0)`,
    })
    .from(guildStatsUserVoiceDaily)
    .where(and(...filters))
    .groupBy(guildStatsUserVoiceDaily.userId)
    .orderBy(desc(sql`coalesce(sum(${guildStatsUserVoiceDaily.minutes}), 0)`))
    .limit(limit);

  return rows;
}

/** `statDate` (text column) lower bound for a window, or null for all-time; same idea as
 *  daily.ts's `windowSinceTimestamp`, but for tables keyed by the text `statDate` column rather
 *  than a timestamp column. */
function windowSinceTimestampForStatDate(days: number): string | null {
  if (isAllTimeWindow(days)) return null;
  return dateRange(days)[0]!;
}
