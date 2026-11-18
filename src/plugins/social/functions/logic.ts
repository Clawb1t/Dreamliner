/**
 * Pure Social Notifications rules (no I/O), shared by the pollers, the bridge and the tests in
 * logic.test.ts: YouTube upload-type detection, quiet hours, cooldowns, stream durations and the
 * stream-ended summary, and subscriber milestones.
 */
import type { FeedFilters, SocialWatcherOptions, YoutubeUploadKind } from "../../../config/schemas/social.js";
import { MILESTONE_UNSEEDED, milestoneAtOrBelow, milestoneToAnnounce } from "../../bluesky/functions/milestones.js";

// ---------------------------------------------------------------------------------------------
// YouTube upload types
// ---------------------------------------------------------------------------------------------

/** Shorts can be up to three minutes long; anything longer is never a Short. */
export const SHORTS_MAX_SECONDS = 180;

/** ISO 8601 duration ("PT1H2M3S", "P1DT2H") to seconds. Null for anything unparseable. */
export function parseIsoDuration(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value.trim());
  if (!match || value.trim() === "P" || value.trim() === "PT") return null;
  const [, d, h, m, s] = match;
  return Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(m ?? 0) * 60 + Math.floor(Number(s ?? 0));
}

export type UploadSignals = {
  /** snippet.liveBroadcastContent: "live", "upcoming" or "none". */
  liveBroadcastContent?: string | null;
  /** videos.list returned a liveStreamingDetails block (live streams, premieres and their VODs). */
  hasLiveStreamingDetails?: boolean;
  /** contentDetails.duration, parsed. Null while it's unknown (e.g. a scheduled stream). */
  durationSeconds?: number | null;
  /** Result of the youtube.com/shorts/<id> check: true/false, or null when it couldn't be made. */
  shortsProbe?: boolean | null;
};

/**
 * What an upload is. Livestreams and premieres (live now, scheduled, or the VOD of one) are
 * "live". Otherwise a video of three minutes or less is a Short when the Shorts URL check says
 * so; when that check couldn't be made, uploads of 60s or less count as Shorts
 * (the old hard limit, so a regular one-minute clip is the only realistic false positive).
 */
export function classifyUpload(signals: UploadSignals): YoutubeUploadKind {
  const broadcast = signals.liveBroadcastContent ?? "none";
  if (broadcast === "live" || broadcast === "upcoming" || signals.hasLiveStreamingDetails) return "live";
  const duration = signals.durationSeconds ?? null;
  if (duration === null || duration <= 0 || duration > SHORTS_MAX_SECONDS) return "video";
  if (signals.shortsProbe === true) return "short";
  if (signals.shortsProbe === false) return "video";
  return duration <= 60 ? "short" : "video";
}

/** Whether this upload type is switched on for the feed (its YouTube filters). */
export function uploadKindEnabled(filters: Pick<FeedFilters, "youtube_videos" | "youtube_shorts" | "youtube_live">, kind: YoutubeUploadKind): boolean {
  if (kind === "short") return filters.youtube_shorts;
  if (kind === "live") return filters.youtube_live;
  return filters.youtube_videos;
}

/** Word used for the {upload_type} token. */
export function uploadKindLabel(kind: YoutubeUploadKind, broadcast?: string | null): string {
  if (kind === "short") return "Short";
  if (kind === "live") return broadcast === "upcoming" ? "upcoming stream" : "livestream";
  return "video";
}

/** Message + roles for an upload type: its own when "custom" is on, otherwise the creator's main ones. */
export function resolveTypeMessage(
  options: SocialWatcherOptions,
  kind: YoutubeUploadKind,
  main: { messageContent: string; mentionRoleIds: string[] },
): { messageContent: string; mentionRoleIds: string[] } {
  const override = kind === "short" ? options.short_override : kind === "live" ? options.live_override : null;
  if (!override?.custom) return main;
  return { messageContent: override.message.trim() ? override.message : main.messageContent, mentionRoleIds: override.role_ids };
}

// ---------------------------------------------------------------------------------------------
// Quiet hours and cooldowns
// ---------------------------------------------------------------------------------------------

/** The hour (0-23) it is right now in `timeZone`; falls back to UTC for an unknown zone. */
export function hourInZone(date: Date, timeZone: string): number {
  try {
    const hour = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(date);
    const n = Number.parseInt(hour, 10);
    return Number.isFinite(n) ? n % 24 : date.getUTCHours();
  } catch {
    return date.getUTCHours();
  }
}

/** Whether `timeZone` is a zone Intl knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Inside quiet hours? The window runs from `start` up to (not including) `end`, and wraps past
 * midnight when start > end (23 to 8 covers 23:00-07:59). start === end means off.
 */
export function isQuietHour(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function inQuietHours(options: SocialWatcherOptions, now: Date = new Date()): boolean {
  if (!options.quiet_enabled) return false;
  return isQuietHour(hourInZone(now, options.quiet_timezone), options.quiet_start, options.quiet_end);
}

/** True while `last` is less than `minutes` ago. */
export function withinCooldown(last: Date | null | undefined, minutes: number, now: Date = new Date()): boolean {
  if (!last || minutes <= 0) return false;
  const age = now.getTime() - last.getTime();
  return age >= 0 && age < minutes * 60_000;
}

// ---------------------------------------------------------------------------------------------
// Twitch stream end
// ---------------------------------------------------------------------------------------------

/** A stream counts as ended once it's been offline this long (rides out short drops). */
export const STREAM_END_GRACE_MS = 4 * 60_000;

export function streamHasEnded(lastSeenLiveAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!lastSeenLiveAt) return true;
  return now.getTime() - lastSeenLiveAt.getTime() >= STREAM_END_GRACE_MS;
}

/** "3h 12m", "45m", "under a minute". */
export function formatStreamDuration(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
  if (totalMinutes < 1) return "under a minute";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes}m`;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

export type StreamSummaryInput = {
  streamerName: string;
  title: string;
  gameName: string | null;
  startedAt: Date;
  endedAt: Date;
  peakViewers: number;
  vodUrl: string | null;
  channelUrl: string;
};

export type StreamSummary = {
  heading: string;
  title: string;
  fields: { name: string; value: string; inline: boolean }[];
  button: { label: string; url: string };
};

/** What the stream-ended edit / summary says. Plain data so it's testable without discord.js. */
export function buildStreamSummary(input: StreamSummaryInput): StreamSummary {
  const duration = formatStreamDuration(input.endedAt.getTime() - input.startedAt.getTime());
  const fields: StreamSummary["fields"] = [{ name: "Streamed for", value: duration, inline: true }];
  if (input.gameName?.trim()) fields.push({ name: "Category", value: input.gameName.trim().slice(0, 1024), inline: true });
  if (input.peakViewers > 0) {
    fields.push({ name: "Peak viewers", value: input.peakViewers.toLocaleString("en-US"), inline: true });
  }
  return {
    heading: `${input.streamerName} was live`,
    title: (input.title.trim() || "Stream").slice(0, 256),
    fields,
    button: input.vodUrl ? { label: "Watch the VOD", url: input.vodUrl } : { label: "Open channel", url: input.channelUrl },
  };
}

// ---------------------------------------------------------------------------------------------
// Subscriber milestones (YouTube)
// ---------------------------------------------------------------------------------------------

export { MILESTONE_UNSEEDED };

/**
 * The subscriber milestone to announce, or null. Hidden counts never announce. YouTube rounds
 * public counts above 1,000 to three significant figures, which the milestone ladder (100, 250,
 * 500, 1K, 2.5K...) lines up with, so a rounded count can't skip past a milestone and back.
 */
export function subscriberMilestoneToAnnounce(lastAnnounced: number, subscribers: number | null, hidden: boolean): number | null {
  if (hidden || subscribers === null || !Number.isFinite(subscribers)) return null;
  return milestoneToAnnounce(lastAnnounced, subscribers);
}

/** Starting point when milestones are switched on: where the channel is now (unseeded if hidden/unknown). */
export function seedSubscriberMilestone(subscribers: number | null, hidden: boolean): number {
  if (hidden || subscribers === null || !Number.isFinite(subscribers)) return MILESTONE_UNSEEDED;
  return milestoneAtOrBelow(subscribers);
}
