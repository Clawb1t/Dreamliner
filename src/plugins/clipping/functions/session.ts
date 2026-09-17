import type { VoiceBasedChannel } from "discord.js";
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type AudioReceiveStream,
  type VoiceConnection,
} from "@discordjs/voice";
import { getLogger } from "../../../core/logger.js";
import { claimVoiceSession, releaseVoiceSession, type VoiceSessionOwner } from "../../../core/voiceSessionRegistry.js";
import { UserOpusRingBuffer } from "./buffer.js";
import { playStartChime } from "./notify.js";

const log = getLogger("clipping");

/** How long the bot stays connected (deafened, idle) after /clipping stop before it leaves on
 *  its own if nobody starts recording again. */
const IDLE_LEAVE_MS = 15 * 60_000;

export type ClipSession = {
  connection: VoiceConnection;
  player: AudioPlayer;
  channel: VoiceBasedChannel;
  guildId: string;
  channelId: string;
  startedBy: string;
  startedAt: number;
  maxBufferMs: number;
  buffers: Map<string, UserOpusRingBuffer>;
  receiverStreams: Map<string, AudioReceiveStream>;
  /** True while actively capturing audio; false when connected-but-idle after /clipping stop
   *  (deafened, buffers cleared, waiting either for /clipping start to resume or for
   *  idleLeaveTimer to fire). */
  recording: boolean;
  idleLeaveTimer: NodeJS.Timeout | null;
};

const sessions = new Map<string, ClipSession>();

export function getSession(guildId: string): ClipSession | undefined {
  return sessions.get(guildId);
}

export function isRecording(guildId: string): boolean {
  return sessions.get(guildId)?.recording === true;
}

function clearIdleLeaveTimer(session: ClipSession): void {
  if (session.idleLeaveTimer) {
    clearTimeout(session.idleLeaveTimer);
    session.idleLeaveTimer = null;
  }
}

/** Starts (or continues) subscribing to a user's raw Opus audio once they're observed speaking.
 *  Lazy — most VC members never speak, so there's no reason to subscribe to all of them upfront. */
function subscribeSpeaker(session: ClipSession, userId: string): void {
  if (!session.recording) return; // Deafened/idle — nothing to subscribe to anyway.
  if (session.receiverStreams.has(userId)) return;

  const stream = session.connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual },
  });
  session.receiverStreams.set(userId, stream);

  let buffer = session.buffers.get(userId);
  if (!buffer) {
    buffer = new UserOpusRingBuffer(session.maxBufferMs);
    session.buffers.set(userId, buffer);
  }
  const activeBuffer = buffer;

  stream.on("data", (chunk: Buffer) => activeBuffer.push(chunk));
  stream.on("error", (err) => log.error(`Clip receiver stream error for user ${userId} in guild ${session.guildId}:`, err));
}

/** Drops all buffered audio and receiver subscriptions — used both by a full leave and by
 *  /clipping stop, since a stopped-but-still-connected session has no reason to keep any of it. */
function discardCaptureState(session: ClipSession): void {
  for (const stream of session.receiverStreams.values()) {
    stream.destroy();
  }
  session.receiverStreams.clear();
  session.buffers.clear();
}

/** Full teardown: leaves the voice channel entirely. Used by the empty-channel watcher, a forced
 *  disconnect, and the idle-leave timer. */
export function leaveChannel(guildId: string, reason: string): void {
  const session = sessions.get(guildId);
  if (!session) return;

  clearIdleLeaveTimer(session);
  discardCaptureState(session);
  sessions.delete(guildId);
  releaseVoiceSession(guildId, "clipping");

  try {
    session.connection.destroy();
  } catch {
    // Already destroyed.
  }
  log.info(`Left voice channel in guild ${guildId} (${reason}).`);
}

export type StopRecordingResult = { ok: true } | { ok: false; reason: "not_recording" };

/** /clipping stop — stops capturing and re-deafens, but stays connected to the channel. Frees
 *  the live buffer immediately (same "delete whatever isn't used" reasoning as leaving), and
 *  starts the idle-leave timer so the bot doesn't linger in the channel forever. */
export function stopRecording(guildId: string): StopRecordingResult {
  const session = sessions.get(guildId);
  if (!session || !session.recording) return { ok: false, reason: "not_recording" };

  discardCaptureState(session);
  session.recording = false;
  session.connection.rejoin({ channelId: session.channelId, selfDeaf: true, selfMute: false });

  clearIdleLeaveTimer(session);
  session.idleLeaveTimer = setTimeout(() => leaveChannel(guildId, "idle after stop"), IDLE_LEAVE_MS);

  return { ok: true };
}

export type StartClippingResult =
  | { ok: true; session: ClipSession; resumed: boolean }
  | { ok: false; reason: "busy_elsewhere" | "join_failed" }
  | { ok: false; reason: "blocked_by_other"; ownedBy: VoiceSessionOwner };

export async function startClipping(
  channel: VoiceBasedChannel,
  startedBy: string,
  maxBufferSeconds: number,
): Promise<StartClippingResult> {
  const guildId = channel.guild.id;
  const existing = sessions.get(guildId);

  if (existing) {
    if (existing.channelId !== channel.id) return { ok: false, reason: "busy_elsewhere" };
    if (existing.recording) return { ok: true, session: existing, resumed: false };

    // Connected-but-idle in the same channel (post /clipping stop) — resume in place rather
    // than leaving and rejoining.
    clearIdleLeaveTimer(existing);
    existing.maxBufferMs = maxBufferSeconds * 1000;
    existing.recording = true;
    existing.connection.rejoin({ channelId: existing.channelId, selfDeaf: false, selfMute: false });
    playStartChime(existing.player);
    return { ok: true, session: existing, resumed: true };
  }

  const claim = claimVoiceSession(guildId, channel.id, "clipping");
  if (!claim.ok) return { ok: false, reason: "blocked_by_other", ownedBy: claim.ownedBy };

  let connection: VoiceConnection;
  try {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      // Must NOT self-deafen while recording (unlike TTS) — a self-deafened connection receives
      // no audio at all. Re-deafened by stopRecording() once capture actually stops.
      selfDeaf: false,
      selfMute: false,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    log.error(`Failed to join VC for clipping in guild ${guildId}:`, err);
    try {
      connection!.destroy();
    } catch {
      // Never got far enough to need destroying.
    }
    releaseVoiceSession(guildId, "clipping");
    return { ok: false, reason: "join_failed" };
  }

  const player = createAudioPlayer();
  connection.subscribe(player);

  const session: ClipSession = {
    connection,
    player,
    channel,
    guildId,
    channelId: channel.id,
    startedBy,
    startedAt: Date.now(),
    maxBufferMs: maxBufferSeconds * 1000,
    buffers: new Map(),
    receiverStreams: new Map(),
    recording: true,
    idleLeaveTimer: null,
  };
  sessions.set(guildId, session);

  connection.receiver.speaking.on("start", (userId) => subscribeSpeaker(session, userId));
  connection.on(VoiceConnectionStatus.Disconnected, () => leaveChannel(guildId, "disconnected"));

  playStartChime(session.player);

  return { ok: true, session, resumed: false };
}
