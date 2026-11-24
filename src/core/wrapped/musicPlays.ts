/**
 * Music play history for Dreamliner Wrapped: one row per track a member requested, written when it
 * actually starts playing. trackStart can fire more than once for the same play (a session resumed
 * after a restart, a failed track retried, a radio ticket swap), so a play is skipped when the same
 * person's same track in the same server was logged within the track's own length.
 */
import { and, desc, eq, gt } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { musicPlayLog } from "../../db/schema.js";
import { getLogger } from "../logger.js";

const log = getLogger("wrapped");

export type MusicPlayInput = {
  userId: string;
  guildId: string;
  title: string;
  author: string | null;
  uri: string | null;
  artworkUrl: string | null;
  sourceName: string | null;
  durationMs: number;
  /** Live streams have no fixed length. */
  isStream?: boolean;
};

export type LoggedPlay = { userId: string; guildId: string; key: string; playedAt: number; durationMs: number };

const MIN_WINDOW_MS = 30_000;
const STREAM_WINDOW_MS = 10 * 60_000;
const MAX_WINDOW_MS = 30 * 60_000;

/** What makes two plays "the same track". */
export function trackKey(input: Pick<MusicPlayInput, "uri" | "title" | "author">): string {
  return input.uri?.trim() || `${input.title.trim().toLowerCase()}|${(input.author ?? "").trim().toLowerCase()}`;
}

/** How long after a play the same track by the same person counts as the same play. A track
 *  looping on repeat starts again once its length has passed, so it counts again. */
export function dedupeWindowMs(durationMs: number, isStream = false): number {
  if (isStream || !Number.isFinite(durationMs) || durationMs <= 0) return STREAM_WINDOW_MS;
  return Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, durationMs - 5_000));
}

export function isDuplicatePlay(previous: LoggedPlay | null | undefined, next: Omit<LoggedPlay, "durationMs"> & { durationMs: number; isStream?: boolean }): boolean {
  if (!previous) return false;
  if (previous.userId !== next.userId || previous.guildId !== next.guildId || previous.key !== next.key) return false;
  const elapsed = next.playedAt - previous.playedAt;
  return elapsed >= 0 && elapsed < dedupeWindowMs(previous.durationMs || next.durationMs, next.isStream);
}

/** Logs one play unless it's a repeat of the last one. Returns whether a row was written. Never throws. */
export function recordMusicPlay(input: MusicPlayInput, now = Date.now()): boolean {
  try {
    if (!input.userId || !input.guildId || !input.title) return false;
    const db = getDb();
    const key = trackKey(input);
    const last = db
      .select()
      .from(musicPlayLog)
      .where(and(eq(musicPlayLog.userId, input.userId), gt(musicPlayLog.playedAt, now - MAX_WINDOW_MS), eq(musicPlayLog.guildId, input.guildId)))
      .orderBy(desc(musicPlayLog.playedAt))
      .limit(1)
      .get();
    const previous = last
      ? { userId: last.userId, guildId: last.guildId, key: trackKey(last), playedAt: last.playedAt, durationMs: last.durationMs }
      : null;
    if (isDuplicatePlay(previous, { userId: input.userId, guildId: input.guildId, key, playedAt: now, durationMs: input.durationMs, isStream: input.isStream })) {
      return false;
    }
    db.insert(musicPlayLog)
      .values({
        userId: input.userId,
        guildId: input.guildId,
        title: input.title.slice(0, 300),
        author: input.author?.slice(0, 200) ?? null,
        uri: input.uri?.slice(0, 500) ?? null,
        artworkUrl: input.artworkUrl?.slice(0, 500) ?? null,
        sourceName: input.sourceName?.slice(0, 40) ?? null,
        durationMs: input.isStream ? 0 : Math.max(0, Math.round(input.durationMs || 0)),
        playedAt: now,
      })
      .run();
    return true;
  } catch (error) {
    log.warn(`Failed to log a music play: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}
