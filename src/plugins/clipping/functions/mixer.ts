/**
 * Decodes each speaker's buffered Opus frames and mixes them into one PCM track. A talk spurt's
 * first frame is placed by wall-clock receive timestamp (so different speakers/pauses line up
 * correctly and gaps where nobody was speaking — Discord never transmits silence — stay silent);
 * every frame after that is glued to the previous one's end rather than re-placed by its own
 * timestamp, so ordinary network jitter in receivedAt doesn't fragment continuous speech into
 * audible micro-gaps/overlaps. Runs only at export time (lazy decode), never on the hot receive path.
 */

import OpusScript from "opusscript";
import type { OpusFrame } from "./buffer.js";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const OUTPUT_FRAME_BYTES = CHANNELS * BYTES_PER_SAMPLE;

/** Discord sends a voice packet every ~20ms during continuous speech; ordinary network/event-loop
 *  jitter routinely makes consecutive packets' `receivedAt` a few ms off that nominal spacing. Any
 *  gap under this threshold is treated as jitter (frames glued back-to-back with no gap or overlap);
 *  anything larger is treated as a real pause (the speaker actually stopped, since Discord never
 *  transmits silence) and placement resyncs to wall-clock time. */
const JITTER_TOLERANCE_MS = 60;

/**
 * Mixes each user's frames (already restricted to the export window) into one PCM buffer of
 * exactly `windowMs` at 48kHz stereo 16-bit. `windowStart` (ms epoch) is the frames' timestamp
 * origin — normally `Date.now() - windowMs`, captured once by the caller before collecting frames
 * from every user's buffer so everyone's audio lines up against the same clock.
 *
 * Overlapping speakers are averaged, not just summed-then-clamped: naive summation clips (harsh
 * digital distortion) the instant two people's waveforms constructively overlap past the 16-bit
 * ceiling, which happens routinely in any conversation with more than one voice. A per-sample
 * contribution count lets solo speech stay at full volume while only genuinely overlapping
 * moments get scaled down to fit.
 */
export function mixWindow(perUserFrames: Map<string, OpusFrame[]>, windowStart: number, windowMs: number): Buffer {
  const totalSamples = Math.round((SAMPLE_RATE * windowMs) / 1000);
  // Wider-than-16-bit accumulator so several simultaneous speakers can sum before averaging.
  const mixed = new Int32Array(totalSamples * CHANNELS);
  const contributions = new Uint16Array(totalSamples);

  for (const frames of perUserFrames.values()) {
    if (frames.length === 0) continue;
    mixUserFrames(frames, windowStart, totalSamples, mixed, contributions);
  }

  const out = Buffer.alloc(totalSamples * OUTPUT_FRAME_BYTES);
  for (let sample = 0; sample < totalSamples; sample++) {
    const count = contributions[sample]!;
    const divisor = count > 1 ? count : 1;
    for (let ch = 0; ch < CHANNELS; ch++) {
      const index = sample * CHANNELS + ch;
      const value = mixed[index]! / divisor;
      const clamped = Math.max(-32768, Math.min(32767, Math.round(value)));
      out.writeInt16LE(clamped, index * BYTES_PER_SAMPLE);
    }
  }
  return out;
}

function mixUserFrames(
  frames: OpusFrame[],
  windowStart: number,
  totalSamples: number,
  mixed: Int32Array,
  contributions: Uint16Array,
): void {
  const decoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
  try {
    // Placing every frame independently at its own wall-clock receivedAt bakes in a few ms of
    // network jitter per packet as a real gap or overlap in the output — at 50 packets/sec that's
    // thousands of tiny discontinuities across a clip, audible as crackle/graininess even though
    // each individual glitch is sub-millisecond. Tracking each speaker's own running sample
    // position and only resyncing to receivedAt after a real pause keeps continuous speech glued
    // together sample-for-sample.
    let nextSample: number | null = null;
    let lastReceivedAt: number | null = null;

    for (const frame of frames) {
      let pcm: Buffer;
      try {
        pcm = decoder.decode(frame.data);
      } catch {
        continue; // Skip an unparsable packet rather than aborting the whole mix.
      }

      const frameSampleCount = Math.floor(pcm.length / OUTPUT_FRAME_BYTES);
      const wallClockSample = Math.round(((frame.receivedAt - windowStart) / 1000) * SAMPLE_RATE);
      const isContinuation: boolean =
        nextSample !== null && lastReceivedAt !== null && frame.receivedAt - lastReceivedAt <= JITTER_TOLERANCE_MS;
      const destStart: number = isContinuation ? nextSample! : wallClockSample;

      for (let i = 0; i < frameSampleCount; i++) {
        const destSample = destStart + i;
        if (destSample < 0) continue;
        if (destSample >= totalSamples) break;
        contributions[destSample]!++;
        for (let ch = 0; ch < CHANNELS; ch++) {
          const srcOffset = i * OUTPUT_FRAME_BYTES + ch * BYTES_PER_SAMPLE;
          mixed[destSample * CHANNELS + ch] += pcm.readInt16LE(srcOffset);
        }
      }

      nextSample = destStart + frameSampleCount;
      lastReceivedAt = frame.receivedAt;
    }
  } finally {
    decoder.delete();
  }
}
