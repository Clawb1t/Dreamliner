import type { Track, UnresolvedTrack } from "lavalink-client";
import { ActionRowBuilder, type ButtonBuilder } from "discord.js";
import { baseEmbed, embedField, type ResultContainer } from "../../../core/embeds.js";
import { linkButton, getGuildMusicPlayerUrl } from "../../../core/docsUrl.js";
import type { MusicLoopMode } from "../../../config/schemas/music.js";
import { MUSIC_EMOJI } from "./emojis.js";

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function trackLink(track: Track): string {
  const title = track.info.title || "Unknown title";
  const label = track.info.author ? `${title} - ${track.info.author}` : title;
  return track.info.uri ? `[${label}](${track.info.uri})` : label;
}

const LOOP_LABELS: Record<MusicLoopMode, string> = {
  off: "off",
  track: "track",
  queue: "queue",
};

export function loopModeLabel(mode: MusicLoopMode): string {
  return LOOP_LABELS[mode];
}

/** Rich track display — thumbnail, code-formatted timestamps, a link button to the source — used
 *  for the commands that actually show a track (play, nowplaying), as opposed to the plain
 *  one-liner acknowledgements below for actions that don't (pause, volume, loop, ...). */
export function buildTrackContainer(
  track: Track,
  opts: {
    kind: "now_playing" | "queued" | "paused";
    positionInQueue?: number;
    positionMs?: number;
  },
): { container: ResultContainer; row?: ActionRowBuilder<ButtonBuilder> } {
  const titleByKind: Record<typeof opts.kind, string> = {
    now_playing: `${MUSIC_EMOJI.play} Now playing`,
    paused: `${MUSIC_EMOJI.pause} Paused`,
    queued: `${MUSIC_EMOJI.queue} Queued`,
  };

  const titleLine = track.info.uri ? `**[${track.info.title || "Unknown title"}](${track.info.uri})**` : `**${track.info.title || "Unknown title"}**`;
  const time = track.info.isStream
    ? "`LIVE`"
    : opts.positionMs !== undefined
      ? `\`${formatDuration(opts.positionMs)} / ${formatDuration(track.info.duration)}\``
      : `\`${formatDuration(track.info.duration)}\``;
  const byLine = track.info.author ? `by ${track.info.author} · ${time}` : time;

  const fields = [];
  if (opts.positionInQueue !== undefined) {
    fields.push(embedField("Position", `#${opts.positionInQueue} in queue`, true));
  }

  const container = baseEmbed()
    .setTitle(titleByKind[opts.kind])
    .setThumbnail(track.info.artworkUrl)
    .setDescription([titleLine, byLine].join("\n"))
    .addFields(fields);

  const row = track.info.uri
    ? new ActionRowBuilder<ButtonBuilder>().addComponents(linkButton("Open track", track.info.uri))
    : undefined;

  return { container, row };
}

/** "Manage this queue online" container - combined into the same message as a track container
 *  (as a second top-level container, not a separate message) on the first track of a fresh
 *  playback session, and again whenever /nowplaying is checked. */
export function buildWebPlayerAnnounceContainer(guildId: string): { container: ResultContainer; row: ActionRowBuilder<ButtonBuilder> } {
  const container = baseEmbed()
    .setTitle(`${MUSIC_EMOJI.music} Manage this queue online`)
    .setDescription("Queue tracks, see album art, and control playback from the web player.");
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    linkButton("Open web player", getGuildMusicPlayerUrl(guildId)),
  );
  return { container, row };
}

// --- One-liner response builders -------------------------------------------------------------
// Deliberately plain strings for actions that don't display a track (pause/volume/loop/...) —
// see buildTrackContainer above for the richer play/nowplaying display.

export function skippedLine(track: Track | null): string {
  return track ? `${MUSIC_EMOJI.skip} Skipped ${trackLink(track)}` : `${MUSIC_EMOJI.skip} Skipped.`;
}

export function stoppedLine(): string {
  return `${MUSIC_EMOJI.stop} Stopped and left the voice channel.`;
}

export function pausedLine(): string {
  return `${MUSIC_EMOJI.pause} Paused.`;
}

export function resumedLine(): string {
  return `${MUSIC_EMOJI.play} Resumed.`;
}

export function volumeLine(volume: number): string {
  const icon = volume === 0 ? MUSIC_EMOJI.mute : volume < 40 ? MUSIC_EMOJI.volumeLow : MUSIC_EMOJI.volume;
  return `${icon} Volume set to **${volume}%**.`;
}

export function loopLine(mode: MusicLoopMode): string {
  return `${MUSIC_EMOJI.loop} Loop mode set to **${loopModeLabel(mode)}**.`;
}

export function shuffledLine(count: number): string {
  return `${MUSIC_EMOJI.shuffle} Shuffled **${count}** track${count === 1 ? "" : "s"}.`;
}

export function seekLine(positionMs: number, durationMs: number): string {
  return `${MUSIC_EMOJI.play} Seeked to **${formatDuration(positionMs)} / ${formatDuration(durationMs)}**.`;
}

export function joinedLine(): string {
  return `${MUSIC_EMOJI.join} Joined the voice channel.`;
}

export function leftLine(): string {
  return `${MUSIC_EMOJI.leave} Left the voice channel.`;
}

export function noResultsLine(query: string): string {
  return `${MUSIC_EMOJI.error} Couldn't find anything for **${query}**.`;
}

export function nothingPlayingLine(): string {
  return `${MUSIC_EMOJI.info} Nothing is playing right now.`;
}

export function trackFailedLine(track: Track | UnresolvedTrack | null, reason: string): string {
  const label = track && !("resolve" in track) ? trackLink(track) : track ? `**${track.info.title}**` : "That track";
  return `${MUSIC_EMOJI.warning} ${label} failed to play (${reason}). Skipping.`;
}
