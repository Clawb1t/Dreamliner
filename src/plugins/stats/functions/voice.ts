import { and, countDistinct, desc, eq, gte, sql } from "drizzle-orm";
import type { Client, VoiceState } from "discord.js";
import { getDb } from "../../../db/client.js";
import {
  guildStatsChannelVoiceDaily,
  guildStatsUserVoiceDaily,
  guildStatsVoiceDaily,
  guildStatsVoiceHourly,
  voiceActiveSessions,
} from "../../../db/schema.js";
import { getLogger } from "../../../core/logger.js";
import { dateRange, isAllTimeWindow, resolveFilledWindow, statDate } from "./daily.js";

const log = getLogger("stats:voice");

type ActiveSession = {
  guildId: string;
  userId: string;
  channelId: string;
  /** Session start, ms epoch. Restored from `voiceActiveSessions` on a restart recovery, so a
   *  redeploy doesn't reset it and silently drop the time someone had already spent in voice. */
  joinedAt: number;
  /** Start of the current mute/deafen/streaming segment, ms epoch — closed out and reset every
   *  time any of those flags change (or the session ends), so time in each state is tracked
   *  precisely instead of just sampled once at join. */
  segmentStartedAt: number;
  selfMute: boolean;
  selfDeaf: boolean;
  /** Camera or screen-share, treated as one "streaming" state. */
  streaming: boolean;
  mutedMs: number;
  deafenedMs: number;
  streamingMs: number;
};

/**
 * In-memory, keyed by `${guildId}:${userId}` — a user can be connected to voice in more than one
 * mutual guild at once, so keying by userId alone (as this used to) would let a second guild's
 * join overwrite the first's in-progress session, silently losing it and misattributing its
 * eventual flush to the wrong guild/channel.
 *
 * The authoritative in-flight state; `voiceActiveSessions` (DB) is a durable mirror of just
 * `joinedAt`/`channelId`, written through on join/switch, so a process restart can recover real
 * session start times instead of resetting everyone's clock to the moment it came back up (see
 * `snapshotActiveVoiceMembers`). Sub-state (mute/deafen/streaming segments) is *not* persisted —
 * cheap to accept losing a few minutes of that granularity across a restart, expensive to persist
 * on every mute/deafen toggle.
 */
const activeSessions = new Map<string, ActiveSession>();

/** Per-guild / per-channel sets of currently-connected (tracked) user ids, kept in sync with
 *  `activeSessions` purely to compute concurrency cheaply for `peakConcurrent` tracking. */
const guildVoiceMembers = new Map<string, Set<string>>();
const channelVoiceMembers = new Map<string, Set<string>>();

function sessionKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

async function incrementVoiceDailyStat(guildId: string, seconds: number, sessions: number): Promise<void> {
  const db = getDb();
  const date = statDate();
  const minutes = Math.round(seconds / 60);
  await db
    .insert(guildStatsVoiceDaily)
    .values({ guildId, statDate: date, minutes, seconds, sessions })
    .onConflictDoUpdate({
      target: [guildStatsVoiceDaily.guildId, guildStatsVoiceDaily.statDate],
      set: {
        minutes: sql`${guildStatsVoiceDaily.minutes} + ${minutes}`,
        seconds: sql`${guildStatsVoiceDaily.seconds} + ${seconds}`,
        sessions: sql`${guildStatsVoiceDaily.sessions} + ${sessions}`,
      },
    });
}

async function incrementUserVoiceDailyStat(
  guildId: string,
  userId: string,
  seconds: number,
  sessions: number,
  mutedSeconds: number,
  deafenedSeconds: number,
  streamingSeconds: number,
): Promise<void> {
  const db = getDb();
  const date = statDate();
  const minutes = Math.round(seconds / 60);
  await db
    .insert(guildStatsUserVoiceDaily)
    .values({
      guildId,
      userId,
      statDate: date,
      minutes,
      seconds,
      sessions,
      mutedSeconds,
      deafenedSeconds,
      streamingSeconds,
    })
    .onConflictDoUpdate({
      target: [guildStatsUserVoiceDaily.guildId, guildStatsUserVoiceDaily.userId, guildStatsUserVoiceDaily.statDate],
      set: {
        minutes: sql`${guildStatsUserVoiceDaily.minutes} + ${minutes}`,
        seconds: sql`${guildStatsUserVoiceDaily.seconds} + ${seconds}`,
        sessions: sql`${guildStatsUserVoiceDaily.sessions} + ${sessions}`,
        mutedSeconds: sql`${guildStatsUserVoiceDaily.mutedSeconds} + ${mutedSeconds}`,
        deafenedSeconds: sql`${guildStatsUserVoiceDaily.deafenedSeconds} + ${deafenedSeconds}`,
        streamingSeconds: sql`${guildStatsUserVoiceDaily.streamingSeconds} + ${streamingSeconds}`,
      },
    });
}

async function incrementChannelVoiceDailyStat(guildId: string, channelId: string, seconds: number, sessions: number): Promise<void> {
  const db = getDb();
  const date = statDate();
  const minutes = Math.round(seconds / 60);
  await db
    .insert(guildStatsChannelVoiceDaily)
    .values({ guildId, channelId, statDate: date, minutes, seconds, sessions })
    .onConflictDoUpdate({
      target: [
        guildStatsChannelVoiceDaily.guildId,
        guildStatsChannelVoiceDaily.channelId,
        guildStatsChannelVoiceDaily.statDate,
      ],
      set: {
        minutes: sql`${guildStatsChannelVoiceDaily.minutes} + ${minutes}`,
        seconds: sql`${guildStatsChannelVoiceDaily.seconds} + ${seconds}`,
        sessions: sql`${guildStatsChannelVoiceDaily.sessions} + ${sessions}`,
      },
    });
}

/** Bumps today's recorded peak concurrency for a guild/channel if `count` is higher than what's
 *  already stored — never lowers it. Only called on join (concurrency can only increase then), so
 *  a leave never needs to touch these. */
async function bumpGuildVoicePeak(guildId: string, count: number): Promise<void> {
  const db = getDb();
  const date = statDate();
  await db
    .insert(guildStatsVoiceDaily)
    .values({ guildId, statDate: date, peakConcurrent: count })
    .onConflictDoUpdate({
      target: [guildStatsVoiceDaily.guildId, guildStatsVoiceDaily.statDate],
      set: { peakConcurrent: sql`MAX(${guildStatsVoiceDaily.peakConcurrent}, ${count})` },
    });
}

async function bumpChannelVoicePeak(guildId: string, channelId: string, count: number): Promise<void> {
  const db = getDb();
  const date = statDate();
  await db
    .insert(guildStatsChannelVoiceDaily)
    .values({ guildId, channelId, statDate: date, peakConcurrent: count })
    .onConflictDoUpdate({
      target: [
        guildStatsChannelVoiceDaily.guildId,
        guildStatsChannelVoiceDaily.channelId,
        guildStatsChannelVoiceDaily.statDate,
      ],
      set: { peakConcurrent: sql`MAX(${guildStatsChannelVoiceDaily.peakConcurrent}, ${count})` },
    });
}

function bumpConcurrency(guildId: string, channelId: string, userId: string): void {
  const guildSet = guildVoiceMembers.get(guildId) ?? new Set<string>();
  guildSet.add(userId);
  guildVoiceMembers.set(guildId, guildSet);

  const channelSet = channelVoiceMembers.get(channelId) ?? new Set<string>();
  channelSet.add(userId);
  channelVoiceMembers.set(channelId, channelSet);

  bumpGuildVoicePeak(guildId, guildSet.size).catch((err) =>
    log.error(`Failed to record voice peak for guild ${guildId}:`, err),
  );
  bumpChannelVoicePeak(guildId, channelId, channelSet.size).catch((err) =>
    log.error(`Failed to record voice peak for channel ${channelId}:`, err),
  );
}

function dropConcurrency(guildId: string, channelId: string, userId: string): void {
  guildVoiceMembers.get(guildId)?.delete(userId);
  channelVoiceMembers.get(channelId)?.delete(userId);
}

async function persistActiveSession(guildId: string, userId: string, channelId: string, joinedAt: number): Promise<void> {
  try {
    await getDb()
      .insert(voiceActiveSessions)
      .values({ guildId, userId, channelId, joinedAt: new Date(joinedAt) })
      .onConflictDoUpdate({
        target: [voiceActiveSessions.guildId, voiceActiveSessions.userId],
        set: { channelId, joinedAt: new Date(joinedAt) },
      });
  } catch (err) {
    log.error(`Failed to persist active voice session for user ${userId} in guild ${guildId}:`, err);
  }
}

async function deletePersistedSession(guildId: string, userId: string): Promise<void> {
  try {
    await getDb()
      .delete(voiceActiveSessions)
      .where(and(eq(voiceActiveSessions.guildId, guildId), eq(voiceActiveSessions.userId, userId)));
  } catch (err) {
    log.error(`Failed to delete persisted voice session for user ${userId} in guild ${guildId}:`, err);
  }
}

/** Closes out the current mute/deafen/streaming segment into the session's running totals and
 *  starts a new one from now. Called whenever those flags might have changed, and once more right
 *  before a session ends so the final segment isn't dropped. */
function closeSegment(session: ActiveSession): void {
  const now = Date.now();
  const elapsedMs = now - session.segmentStartedAt;
  if (elapsedMs > 0) {
    if (session.selfMute) session.mutedMs += elapsedMs;
    if (session.selfDeaf) session.deafenedMs += elapsedMs;
    if (session.streaming) session.streamingMs += elapsedMs;
  }
  session.segmentStartedAt = now;
}

type VoiceFlags = {
  selfMute?: boolean | null;
  selfDeaf?: boolean | null;
  selfVideo?: boolean | null;
  streaming?: boolean | null;
};

/** Starts tracking a session. `resumeJoinedAt` is only passed by restart recovery, to preserve a
 *  real join time recovered from `voiceActiveSessions` instead of starting the clock at "now". */
async function startSession(
  guildId: string,
  userId: string,
  channelId: string,
  flags: VoiceFlags,
  resumeJoinedAt?: number,
): Promise<void> {
  const now = Date.now();
  const joinedAt = resumeJoinedAt ?? now;
  const session: ActiveSession = {
    guildId,
    userId,
    channelId,
    joinedAt,
    segmentStartedAt: now,
    selfMute: Boolean(flags.selfMute),
    selfDeaf: Boolean(flags.selfDeaf),
    streaming: Boolean(flags.selfVideo) || Boolean(flags.streaming),
    mutedMs: 0,
    deafenedMs: 0,
    streamingMs: 0,
  };
  activeSessions.set(sessionKey(guildId, userId), session);
  bumpConcurrency(guildId, channelId, userId);
  if (resumeJoinedAt === undefined) {
    await persistActiveSession(guildId, userId, channelId, joinedAt);
  }
}

/** Flushes a tracked session's elapsed time into all voice tables, crediting it entirely to
 *  today's stat date. Deliberate simplification: a session spanning midnight UTC is credited
 *  entirely to the day it ends on, not split across the boundary. Never throws. */
async function flushSession(guildId: string, userId: string): Promise<void> {
  const key = sessionKey(guildId, userId);
  const session = activeSessions.get(key);
  if (!session) return;
  activeSessions.delete(key);
  closeSegment(session); // folds the final in-progress segment into mutedMs/deafenedMs/streamingMs
  dropConcurrency(guildId, session.channelId, userId);
  await deletePersistedSession(guildId, userId);

  const totalSeconds = Math.max(0, Math.round((session.segmentStartedAt - session.joinedAt) / 1000));
  const mutedSeconds = Math.round(session.mutedMs / 1000);
  const deafenedSeconds = Math.round(session.deafenedMs / 1000);
  const streamingSeconds = Math.round(session.streamingMs / 1000);

  try {
    await Promise.all([
      incrementVoiceDailyStat(guildId, totalSeconds, 1),
      incrementUserVoiceDailyStat(guildId, userId, totalSeconds, 1, mutedSeconds, deafenedSeconds, streamingSeconds),
      incrementChannelVoiceDailyStat(guildId, session.channelId, totalSeconds, 1),
    ]);
  } catch (err) {
    log.error(`Failed to flush voice session for user ${userId} in guild ${guildId}:`, err);
  }
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
    const afkChannelId = newState.guild.afkChannelId;

    if (oldChannelId === newChannelId) {
      // No channel change — only self-mute/deafen/streaming flags may have moved. Only relevant
      // if we're actually tracking a session right now (never true for the AFK channel, which
      // never gets one).
      if (newChannelId !== null && newChannelId !== afkChannelId) {
        const session = activeSessions.get(sessionKey(guildId, userId));
        if (session) {
          closeSegment(session);
          session.selfMute = Boolean(newState.selfMute);
          session.selfDeaf = Boolean(newState.selfDeaf);
          session.streaming = Boolean(newState.selfVideo) || Boolean(newState.streaming);
        }
      }
      return;
    }

    // Channel changed (join, leave, switch, or moved into/out of the AFK channel): close out
    // whatever was being tracked for the channel they just left.
    await flushSession(guildId, userId);

    // Left voice entirely, or Discord moved them to the AFK channel (its own idle-timeout, or a
    // moderator) — neither counts as active voice presence, so no new session starts.
    if (newChannelId === null || newChannelId === afkChannelId) return;

    await startSession(guildId, userId, newChannelId, newState);
  } catch (err) {
    log.error("handleVoiceStateUpdate failed:", err);
  }
}

/**
 * Called once on plugin boot to recover from a restart, for every guild the bot is in — voice
 * tracking has no per-guild opt-out (see the VoiceStateUpdate handler in stats/index.ts), so this
 * always runs for the whole client, not a filtered subset. Anyone still connected to the exact channel a
 * durable `voiceActiveSessions` row remembers them in gets their real `joinedAt` back, so a
 * redeploy no longer silently resets everyone's voice-time clock to the moment the process came
 * back up. Anyone whose row doesn't match current reality (channel changed, or they left entirely
 * while the process was down) gets a fresh session starting now — reconstructing exactly how long
 * they were connected during the outage isn't possible without a shutdown timestamp, so that
 * portion is accepted as lost, same as this feature's existing best-effort philosophy.
 */
export async function snapshotActiveVoiceMembers(client: Client): Promise<void> {
  try {
    const db = getDb();
    const persisted = await db.select().from(voiceActiveSessions);
    const persistedByKey = new Map(persisted.map((row) => [sessionKey(row.guildId, row.userId), row]));
    const seenKeys = new Set<string>();

    for (const guild of client.guilds.cache.values()) {
      const afkChannelId = guild.afkChannelId;
      for (const channel of guild.channels.cache.values()) {
        if (!channel.isVoiceBased() || channel.id === afkChannelId) continue;
        for (const member of channel.members.values()) {
          if (member.user.bot) continue;
          const key = sessionKey(guild.id, member.id);
          seenKeys.add(key);
          if (activeSessions.has(key)) continue;

          const persistedRow = persistedByKey.get(key);
          const resumeJoinedAt =
            persistedRow && persistedRow.channelId === channel.id ? persistedRow.joinedAt.getTime() : undefined;

          await startSession(
            guild.id,
            member.id,
            channel.id,
            {
              selfMute: member.voice.selfMute,
              selfDeaf: member.voice.selfDeaf,
              selfVideo: member.voice.selfVideo,
              streaming: member.voice.streaming,
            },
            resumeJoinedAt,
          );
        }
      }
    }

    // Durable rows for anyone who left voice entirely while the process was down.
    const stale = persisted.filter((row) => !seenKeys.has(sessionKey(row.guildId, row.userId)));
    if (stale.length > 0) {
      await Promise.all(stale.map((row) => deletePersistedSession(row.guildId, row.userId)));
    }
  } catch (err) {
    log.error("snapshotActiveVoiceMembers failed:", err);
  }
}

const VOICE_HOURLY_SAMPLE_MS = 5 * 60_000;

/** Samples current voice occupancy every `VOICE_HOURLY_SAMPLE_MS` and credits that many
 *  person-minutes to the current UTC weekday/hour bucket, per guild. Polling rather than
 *  accounting this off session-flush deliberately: a single voice session can span many hour
 *  buckets, and flush-time accounting would misattribute all of it to whichever hour the session
 *  happened to end in. Independent of the minute/second tables above — this only ever writes to
 *  `guildStatsVoiceHourly`, so there's no double-counting risk between the two. */
async function sampleVoiceHourlyActivity(): Promise<void> {
  if (activeSessions.size === 0) return;
  const now = new Date();
  const weekdayUtc = now.getUTCDay();
  const hourUtc = now.getUTCHours();
  const sampleMinutes = VOICE_HOURLY_SAMPLE_MS / 60_000;

  const byGuild = new Map<string, number>();
  for (const session of activeSessions.values()) {
    byGuild.set(session.guildId, (byGuild.get(session.guildId) ?? 0) + 1);
  }

  const db = getDb();
  await Promise.all(
    [...byGuild.entries()].map(([guildId, count]) => {
      const minutes = sampleMinutes * count;
      return db
        .insert(guildStatsVoiceHourly)
        .values({ guildId, weekdayUtc, hourUtc, minutes })
        .onConflictDoUpdate({
          target: [guildStatsVoiceHourly.guildId, guildStatsVoiceHourly.weekdayUtc, guildStatsVoiceHourly.hourUtc],
          set: { minutes: sql`${guildStatsVoiceHourly.minutes} + ${minutes}` },
        });
    }),
  );
}

/**
 * Flushes every currently-active session's elapsed-so-far time into the daily tables without
 * ending the session, on the same cadence as the hourly sampler above. Without this, someone
 * sitting in voice for an hour shows up as *zero* voice time anywhere on the dashboard/leaderboard
 * until they actually disconnect — flush only happens on leave/switch otherwise, which reads as
 * "voice tracking isn't working" to anyone checking while people are still connected. This makes
 * partial progress visible within one sample interval instead of only at the end of a session.
 *
 * Advances `session.joinedAt`/segment accumulators to "now" after each flush so the eventual real
 * flush (on leave) only ever double-adds the *unflushed remainder*, never the whole session again
 * — and re-persists the durable session row at the new checkpoint, so a restart mid-session only
 * ever needs to recover that same small remainder. `sessions` delta is 0 here (the session hasn't
 * ended) — only the real flush on leave counts a completed session.
 */
async function partialFlushActiveSessions(): Promise<void> {
  const entries = [...activeSessions.entries()];
  for (const [key, session] of entries) {
    closeSegment(session);
    const now = session.segmentStartedAt;
    const elapsedSeconds = Math.max(0, Math.round((now - session.joinedAt) / 1000));
    const mutedSeconds = Math.round(session.mutedMs / 1000);
    const deafenedSeconds = Math.round(session.deafenedMs / 1000);
    const streamingSeconds = Math.round(session.streamingMs / 1000);
    if (elapsedSeconds <= 0 && mutedSeconds <= 0 && deafenedSeconds <= 0 && streamingSeconds <= 0) continue;

    // Advance the checkpoint before awaiting anything, so a real leave that lands mid-flush
    // (below) only ever accounts for time after this point, never re-adding what's flushed here.
    session.joinedAt = now;
    session.mutedMs = 0;
    session.deafenedMs = 0;
    session.streamingMs = 0;

    try {
      await Promise.all([
        incrementVoiceDailyStat(session.guildId, elapsedSeconds, 0),
        incrementUserVoiceDailyStat(session.guildId, session.userId, elapsedSeconds, 0, mutedSeconds, deafenedSeconds, streamingSeconds),
        incrementChannelVoiceDailyStat(session.guildId, session.channelId, elapsedSeconds, 0),
      ]);
      // Only re-persist if the session is still live — it may have ended (and deleted its own
      // durable row) while the increments above were in flight.
      if (activeSessions.get(key) === session) {
        await persistActiveSession(session.guildId, session.userId, session.channelId, now);
      }
    } catch (err) {
      log.error(`Failed to partially flush voice session ${key}:`, err);
    }
  }
}

/** Wired up once from the stats plugin's onLoad, alongside snapshotActiveVoiceMembers. */
export function startVoiceHourlySampler(): void {
  setInterval(() => {
    sampleVoiceHourlyActivity().catch((err) => log.error("Voice hourly sampler failed:", err));
    partialFlushActiveSessions().catch((err) => log.error("Voice partial-flush sampler failed:", err));
  }, VOICE_HOURLY_SAMPLE_MS);
}

export type VoiceDailyRow = { statDate: string; minutes: number };

/** A row's effective seconds: `MAX(seconds, minutes * 60)`, not just "prefer seconds when
 *  present" — a row touched both before and after this column existed (the single day this
 *  shipped, for any guild with activity that day) has real `minutes` from the legacy write path
 *  plus only the *post-deploy portion* in `seconds`, so trusting `seconds` alone whenever it's
 *  nonzero would undercount that day. `minutes` keeps being written by every flush regardless
 *  (see incrementVoiceDailyStat etc.), so it's always at least as complete a running total;
 *  `seconds` is only ever preferred when it's actually the larger, more precise figure. */
function effectiveSecondsExpr(seconds: unknown, minutes: unknown) {
  return sql<number>`MAX(${seconds}, ${minutes} * 60)`;
}

/** Zero-filled minutes-per-day series, mirrors getFilledDailyStats in daily.ts. */
export async function getFilledVoiceDailyStats(guildId: string, days: number = 14): Promise<VoiceDailyRow[]> {
  const db = getDb();

  if (isAllTimeWindow(days)) {
    const rows = await db
      .select()
      .from(guildStatsVoiceDaily)
      .where(eq(guildStatsVoiceDaily.guildId, guildId));
    const dates = resolveFilledWindow(days, rows.map((row) => row.statDate));
    const byDate = new Map(rows.map((row) => [row.statDate, Math.round(Math.max(row.seconds, row.minutes * 60) / 60)]));
    return dates.map((date) => ({ statDate: date, minutes: byDate.get(date) ?? 0 }));
  }

  const dates = dateRange(days);
  const since = dates[0]!;
  const rows = await db
    .select()
    .from(guildStatsVoiceDaily)
    .where(and(eq(guildStatsVoiceDaily.guildId, guildId), gte(guildStatsVoiceDaily.statDate, since)));

  const byDate = new Map(rows.map((row) => [row.statDate, Math.round(Math.max(row.seconds, row.minutes * 60) / 60)]));
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

  const secondsExpr = effectiveSecondsExpr(guildStatsChannelVoiceDaily.seconds, guildStatsChannelVoiceDaily.minutes);
  const rows = await db
    .select({
      channelId: guildStatsChannelVoiceDaily.channelId,
      seconds: sql<number>`coalesce(sum(${secondsExpr}), 0)`,
    })
    .from(guildStatsChannelVoiceDaily)
    .where(and(...filters))
    .groupBy(guildStatsChannelVoiceDaily.channelId)
    .orderBy(desc(sql`coalesce(sum(${secondsExpr}), 0)`))
    .limit(limit);

  return rows.map((row) => ({ channelId: row.channelId, minutes: Math.round(row.seconds / 60) }));
}

/** Top voice users by summed time over the window (or all time). `seconds` is the exact total
 *  (for a precise "Xm Ys" display); `minutes` is the same value rounded, kept for callers that
 *  only want the coarser figure. */
export async function getTopVoiceUsers(
  guildId: string,
  days: number = 14,
  limit = 5,
): Promise<{ userId: string; minutes: number; seconds: number }[]> {
  const db = getDb();
  const since = windowSinceTimestampForStatDate(days);
  const filters = [eq(guildStatsUserVoiceDaily.guildId, guildId)];
  if (since) filters.push(gte(guildStatsUserVoiceDaily.statDate, since));

  const secondsExpr = effectiveSecondsExpr(guildStatsUserVoiceDaily.seconds, guildStatsUserVoiceDaily.minutes);
  const rows = await db
    .select({
      userId: guildStatsUserVoiceDaily.userId,
      seconds: sql<number>`coalesce(sum(${secondsExpr}), 0)`,
    })
    .from(guildStatsUserVoiceDaily)
    .where(and(...filters))
    .groupBy(guildStatsUserVoiceDaily.userId)
    .orderBy(desc(sql`coalesce(sum(${secondsExpr}), 0)`))
    .limit(limit);

  return rows.map((row) => ({ userId: row.userId, minutes: Math.round(row.seconds / 60), seconds: row.seconds }));
}

/** `statDate` (text column) lower bound for a window, or null for all-time; same idea as
 *  daily.ts's `windowSinceTimestamp`, but for tables keyed by the text `statDate` column rather
 *  than a timestamp column. */
function windowSinceTimestampForStatDate(days: number): string | null {
  if (isAllTimeWindow(days)) return null;
  return dateRange(days)[0]!;
}

/** Lifetime (or windowed) total voice minutes across the whole guild — the voice-leaderboard
 *  counterpart of queries.ts's `getTrackedMessagesTotal`. There's no separate lifetime counter
 *  table for voice (unlike messages), so this sums the daily table directly. */
export async function getGuildTotalVoiceMinutes(guildId: string, days: number = 0): Promise<number> {
  const db = getDb();
  const since = windowSinceTimestampForStatDate(days);
  const filters = [eq(guildStatsVoiceDaily.guildId, guildId)];
  if (since) filters.push(gte(guildStatsVoiceDaily.statDate, since));

  const secondsExpr = effectiveSecondsExpr(guildStatsVoiceDaily.seconds, guildStatsVoiceDaily.minutes);
  const row = await db
    .select({ total: sql<number>`coalesce(sum(${secondsExpr}), 0)` })
    .from(guildStatsVoiceDaily)
    .where(and(...filters))
    .get();
  return Math.round(Number(row?.total ?? 0) / 60);
}

/** Distinct members with any tracked voice time (lifetime, or within a window) — the voice
 *  counterpart of queries.ts's `getActiveMessagerCount`. */
export async function getActiveVoiceUserCount(guildId: string, days: number = 0): Promise<number> {
  const db = getDb();
  const since = windowSinceTimestampForStatDate(days);
  const filters = [eq(guildStatsUserVoiceDaily.guildId, guildId)];
  if (since) filters.push(gte(guildStatsUserVoiceDaily.statDate, since));

  const row = await db
    .select({ total: countDistinct(guildStatsUserVoiceDaily.userId) })
    .from(guildStatsUserVoiceDaily)
    .where(and(...filters))
    .get();
  return Number(row?.total ?? 0);
}

/** Guild-wide voice engagement extras beyond plain minutes: total sessions (so average session
 *  length = minutes / sessions is derivable) and the highest concurrent voice presence seen. */
export async function getGuildVoiceEngagement(
  guildId: string,
  days: number = 14,
): Promise<{ sessions: number; peakConcurrent: number }> {
  const db = getDb();
  const since = windowSinceTimestampForStatDate(days);
  const filters = [eq(guildStatsVoiceDaily.guildId, guildId)];
  if (since) filters.push(gte(guildStatsVoiceDaily.statDate, since));

  const row = await db
    .select({
      sessions: sql<number>`coalesce(sum(${guildStatsVoiceDaily.sessions}), 0)`,
      peakConcurrent: sql<number>`coalesce(max(${guildStatsVoiceDaily.peakConcurrent}), 0)`,
    })
    .from(guildStatsVoiceDaily)
    .where(and(...filters))
    .get();
  return { sessions: Number(row?.sessions ?? 0), peakConcurrent: Number(row?.peakConcurrent ?? 0) };
}

/** Per-user voice engagement breakdown: sessions (for avg session length) plus how much of their
 *  tracked time was spent muted, deafened, or streaming (camera/screen-share). */
export async function getUserVoiceEngagement(
  guildId: string,
  userId: string,
  days: number = 0,
): Promise<{ sessions: number; mutedMinutes: number; deafenedMinutes: number; streamingMinutes: number }> {
  const db = getDb();
  const since = windowSinceTimestampForStatDate(days);
  const filters = [eq(guildStatsUserVoiceDaily.guildId, guildId), eq(guildStatsUserVoiceDaily.userId, userId)];
  if (since) filters.push(gte(guildStatsUserVoiceDaily.statDate, since));

  const row = await db
    .select({
      sessions: sql<number>`coalesce(sum(${guildStatsUserVoiceDaily.sessions}), 0)`,
      mutedSeconds: sql<number>`coalesce(sum(${guildStatsUserVoiceDaily.mutedSeconds}), 0)`,
      deafenedSeconds: sql<number>`coalesce(sum(${guildStatsUserVoiceDaily.deafenedSeconds}), 0)`,
      streamingSeconds: sql<number>`coalesce(sum(${guildStatsUserVoiceDaily.streamingSeconds}), 0)`,
    })
    .from(guildStatsUserVoiceDaily)
    .where(and(...filters))
    .get();
  return {
    sessions: Number(row?.sessions ?? 0),
    mutedMinutes: Math.round(Number(row?.mutedSeconds ?? 0) / 60),
    deafenedMinutes: Math.round(Number(row?.deafenedSeconds ?? 0) / 60),
    streamingMinutes: Math.round(Number(row?.streamingSeconds ?? 0) / 60),
  };
}

/** Zero-filled 7 (weekday, UTC) x 24 (hour, UTC) voice-activity grid, mirrors
 *  daily.ts's getGuildHourlyHeatmap for messages. Populated by the periodic sampler above, not
 *  session flush — see sampleVoiceHourlyActivity's comment for why. */
export async function getGuildVoiceHourlyHeatmap(
  guildId: string,
): Promise<{ weekday: number; hour: number; minutes: number }[]> {
  const db = getDb();
  const rows = await db.select().from(guildStatsVoiceHourly).where(eq(guildStatsVoiceHourly.guildId, guildId));
  const byCell = new Map(rows.map((row) => [`${row.weekdayUtc}:${row.hourUtc}`, row.minutes]));

  const grid: { weekday: number; hour: number; minutes: number }[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      grid.push({ weekday, hour, minutes: byCell.get(`${weekday}:${hour}`) ?? 0 });
    }
  }
  return grid;
}
