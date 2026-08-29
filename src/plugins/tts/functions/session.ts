import { Readable } from "node:stream";
import type { VoiceBasedChannel } from "discord.js";
import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import type { PreparedAudio } from "./synth.js";

type GuildSession = {
  connection: VoiceConnection;
  player: AudioPlayer;
  channel: VoiceBasedChannel;
  channelId: string;
  queue: PreparedAudio[];
  playing: boolean;
  idleTimer: NodeJS.Timeout | null;
};

const sessions = new Map<string, GuildSession>();

/** How long to keep an idle connection open in case another /tts follows soon. */
const IDLE_DISCONNECT_MS = 10 * 60_000;

function clearIdleTimer(session: GuildSession): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

function teardown(guildId: string, session: GuildSession): void {
  clearIdleTimer(session);
  sessions.delete(guildId);
  try {
    session.connection.destroy();
  } catch {
    // Already destroyed.
  }
}

function scheduleIdleDisconnect(guildId: string, session: GuildSession): void {
  clearIdleTimer(session);
  session.idleTimer = setTimeout(() => teardown(guildId, session), IDLE_DISCONNECT_MS);
}

function playNext(guildId: string): void {
  const session = sessions.get(guildId);
  if (!session) return;

  const next = session.queue.shift();
  if (!next) {
    session.playing = false;
    scheduleIdleDisconnect(guildId, session);
    return;
  }

  session.playing = true;
  clearIdleTimer(session);
  const resource = createAudioResource(Readable.from(next.buffer), { inputType: next.inputType });
  session.player.play(resource);
}

/**
 * Stops whatever's currently playing in this guild and lets the player's own Idle handler
 * advance to the next queued clip (or go idle if the queue's empty). Returns false if nothing
 * was playing.
 */
export function skipCurrent(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session || !session.playing) return false;
  session.player.stop(true);
  return true;
}

export type SpeakResult = { ok: true } | { ok: false; reason: "busy_elsewhere" | "join_failed" };

/**
 * Queues `audio` to be spoken in `channel`. Joins the channel if Dreamliner isn't already
 * connected there. If Dreamliner is speaking in a different channel in the same guild, the
 * request is rejected rather than interrupting that session.
 */
export async function speakInChannel(channel: VoiceBasedChannel, audio: PreparedAudio): Promise<SpeakResult> {
  const guildId = channel.guild.id;
  let session = sessions.get(guildId);

  if (session && session.channelId !== channel.id) {
    if (session.playing || session.queue.length > 0) {
      return { ok: false, reason: "busy_elsewhere" };
    }
    teardown(guildId, session);
    session = undefined;
  }

  if (!session) {
    let connection: VoiceConnection;
    try {
      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false,
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch {
      return { ok: false, reason: "join_failed" };
    }

    const player = createAudioPlayer();
    connection.subscribe(player);

    const created: GuildSession = {
      connection,
      player,
      channel,
      channelId: channel.id,
      queue: [],
      playing: false,
      idleTimer: null,
    };
    sessions.set(guildId, created);
    session = created;

    player.on(AudioPlayerStatus.Idle, () => playNext(guildId));
    player.on("error", () => playNext(guildId));
    connection.on(VoiceConnectionStatus.Disconnected, () => teardown(guildId, created));
  }

  session.queue.push(audio);
  if (!session.playing) playNext(guildId);
  return { ok: true };
}
