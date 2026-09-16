/**
 * Per-user rolling buffer of raw (still Opus-encoded) audio frames received from a voice
 * connection. Frames are kept Opus-encoded, not decoded to PCM, because Discord's receiver only
 * emits packets while a user is actually speaking: a full 5 minutes of Opus at Discord's voice
 * bitrate is roughly 2.4MB per user, versus ~57.6MB per user if this stored decoded 48kHz stereo
 * PCM instead. Decoding only happens lazily, per requested export window, in mixer.ts.
 */

export type OpusFrame = {
  data: Buffer;
  /** Wall-clock ms (Date.now()) this frame was received — used to place it on the output
   *  timeline at export time, since silence between frames is never transmitted. */
  receivedAt: number;
};

export class UserOpusRingBuffer {
  private frames: OpusFrame[] = [];

  constructor(private readonly maxAgeMs: number) {}

  /** `receivedAt` defaults to `Date.now()` — overridable so buffer/prune math is deterministically testable. */
  push(data: Buffer, receivedAt = Date.now()): void {
    this.frames.push({ data, receivedAt });
    this.pruneOlderThan(receivedAt - this.maxAgeMs);
  }

  /** Drops frames received before `cutoff` (ms epoch). Frames arrive in time order, so this is
   *  an amortized-O(1) trim off the front rather than a full-array scan. */
  private pruneOlderThan(cutoff: number): void {
    let dropCount = 0;
    while (dropCount < this.frames.length && this.frames[dropCount]!.receivedAt < cutoff) {
      dropCount++;
    }
    if (dropCount > 0) this.frames.splice(0, dropCount);
  }

  /** Frames received within the last `windowMs`, oldest first. `now` defaults to `Date.now()`. */
  getFramesInWindow(windowMs: number, now = Date.now()): OpusFrame[] {
    const cutoff = now - windowMs;
    const startIndex = this.frames.findIndex((frame) => frame.receivedAt >= cutoff);
    if (startIndex === -1) return [];
    return this.frames.slice(startIndex);
  }

  isEmpty(): boolean {
    return this.frames.length === 0;
  }

  approximateByteSize(): number {
    return this.frames.reduce((total, frame) => total + frame.data.length, 0);
  }
}
