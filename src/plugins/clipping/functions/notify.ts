/**
 * Notification chimes, synthesized at runtime rather than shipped as binary assets — the same
 * "no repo assets for a trivial waveform" reasoning as tts/functions/wav.ts's WAV header
 * generation. Three distinct multi-note patterns (recording started, clip taken, clip failed) so
 * everyone in the channel can tell what happened by ear alone, without seeing the reply.
 */

import { Readable } from "node:stream";
import { StreamType, createAudioResource, type AudioPlayer } from "@discordjs/voice";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;

/** One note with a fast attack and an exponential decay tail (bell-like, not a flat beep), plus a
 *  faint second harmonic for a fuller chime timbre. Returns raw signed-16-bit little-endian
 *  stereo PCM. */
function synthesizeTone(freqHz: number, durationMs: number, amplitude = 0.28): Buffer {
  const sampleCount = Math.round((SAMPLE_RATE * durationMs) / 1000);
  const pcm = Buffer.alloc(sampleCount * CHANNELS * 2);
  const attackSamples = Math.max(1, Math.round(SAMPLE_RATE * 0.006));

  for (let i = 0; i < sampleCount; i++) {
    const envelope =
      i < attackSamples ? i / attackSamples : Math.pow(1 - (i - attackSamples) / (sampleCount - attackSamples), 1.6);

    const fundamental = Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE);
    const overtone = Math.sin((2 * Math.PI * freqHz * 2 * i) / SAMPLE_RATE) * 0.25;
    const sample = (fundamental + overtone) * amplitude * envelope;
    const intSample = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));

    const offset = i * CHANNELS * 2;
    pcm.writeInt16LE(intSample, offset);
    pcm.writeInt16LE(intSample, offset + 2);
  }

  return pcm;
}

function concatTones(tones: Buffer[], gapMs = 20): Buffer {
  if (tones.length <= 1) return tones[0] ?? Buffer.alloc(0);
  const gap = Buffer.alloc(Math.round((SAMPLE_RATE * gapMs) / 1000) * CHANNELS * 2);
  const parts: Buffer[] = [];
  tones.forEach((tone, index) => {
    parts.push(tone);
    if (index < tones.length - 1) parts.push(gap);
  });
  return Buffer.concat(parts);
}

function playPcm(player: AudioPlayer, pcm: Buffer): void {
  const resource = createAudioResource(Readable.from(pcm), { inputType: StreamType.Raw });
  player.play(resource);
}

/** Four-note ascending arpeggio (C5-E5-G5-C6) — "recording started", ~600ms. */
export function playStartChime(player: AudioPlayer): void {
  playPcm(
    player,
    concatTones([synthesizeTone(523.25, 130), synthesizeTone(659.25, 130), synthesizeTone(783.99, 130), synthesizeTone(1046.5, 170)]),
  );
}

/** Three-note ascending major triad (G5-B5-D6), quicker and brighter than the start chime — "clip
 *  taken", ~330ms. */
export function playClipChime(player: AudioPlayer): void {
  playPcm(player, concatTones([synthesizeTone(783.99, 100), synthesizeTone(987.77, 100), synthesizeTone(1174.66, 130)], 15));
}

/** Three-note descending minor pattern (A4-F4-D4) — deliberately the opposite direction/mood of
 *  the other two chimes, so a failed export is audibly distinguishable, ~530ms. */
export function playClipFailedChime(player: AudioPlayer): void {
  playPcm(player, concatTones([synthesizeTone(440, 150), synthesizeTone(349.23, 150), synthesizeTone(293.66, 180)], 25));
}
