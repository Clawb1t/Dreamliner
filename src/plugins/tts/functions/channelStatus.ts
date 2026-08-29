import type { VoiceBasedChannel } from "discord.js";
import { setVoiceChannelStatus } from "../../../core/voiceChannelStatus.js";

/**
 * Keeps a voice channel's status showing who's currently being read aloud there, without
 * risking Discord's rate limit on the voice-status endpoint. discord.js's own REST manager
 * already queues/retries against the server's real rate-limit headers, so a call here is never
 * dropped outright — but letting every speaker change fire its own request would still queue up
 * a backlog of updates that land late and flicker through stale, already-past speakers. Instead:
 * at most one request per channel per MIN_INTERVAL_MS, and if several changes land inside that
 * window, only the last one actually gets sent once the window ends — everything in between is
 * dropped, never queued.
 */
const MIN_INTERVAL_MS = 10_000;
const STATUS_MAX_LENGTH = 500;

type ThrottleState = {
  lastSentAt: number;
  /** The status we most recently sent or have scheduled to send next. */
  desired: string;
  pendingTimer: NodeJS.Timeout | null;
};

const state = new Map<string, ThrottleState>();

function truncate(text: string): string {
  return text.length > STATUS_MAX_LENGTH ? `${text.slice(0, STATUS_MAX_LENGTH - 1)}…` : text;
}

function send(channel: VoiceBasedChannel, entry: ThrottleState, status: string): void {
  entry.lastSentAt = Date.now();
  void setVoiceChannelStatus(channel, status || null).catch(() => {});
}

/**
 * Requests the channel's status be set to `status` (empty string clears it). Coalesces rapid
 * changes so at most one actually reaches Discord per MIN_INTERVAL_MS for a given channel.
 */
export function scheduleVoiceStatus(channel: VoiceBasedChannel, status: string): void {
  const target = truncate(status);
  let entry = state.get(channel.id);
  if (!entry) {
    entry = { lastSentAt: 0, desired: "", pendingTimer: null };
    state.set(channel.id, entry);
  }

  if (entry.desired === target) return; // already showing this, or already the pending target

  entry.desired = target;

  const elapsed = Date.now() - entry.lastSentAt;
  if (elapsed >= MIN_INTERVAL_MS) {
    if (entry.pendingTimer) {
      clearTimeout(entry.pendingTimer);
      entry.pendingTimer = null;
    }
    send(channel, entry, target);
    return;
  }

  if (entry.pendingTimer) return; // a trailing update is already scheduled; it'll pick up `desired` when it fires

  entry.pendingTimer = setTimeout(() => {
    entry!.pendingTimer = null;
    send(channel, entry!, entry!.desired);
  }, MIN_INTERVAL_MS - elapsed);
}
