import { describe, it } from "node:test";
import assert from "node:assert/strict";
import OpusScript from "opusscript";
import { mixWindow } from "./mixer.js";
import type { OpusFrame } from "./buffer.js";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_SIZE = 960; // 20ms at 48kHz, matching Discord's voice frame size

function encodeToneFrame(freqHz: number, amplitude = 12000): Buffer {
  const pcm = Buffer.alloc(FRAME_SIZE * CHANNELS * 2);
  for (let i = 0; i < FRAME_SIZE; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE) * amplitude);
    pcm.writeInt16LE(sample, i * 4);
    pcm.writeInt16LE(sample, i * 4 + 2);
  }
  const encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
  try {
    return encoder.encode(pcm, FRAME_SIZE);
  } finally {
    encoder.delete();
  }
}

function rmsAt(mixedPcm: Buffer, sampleStart: number, sampleCount: number): number {
  let sumSquares = 0;
  let counted = 0;
  for (let i = sampleStart; i < sampleStart + sampleCount; i++) {
    const offset = i * CHANNELS * 2;
    if (offset < 0 || offset + 2 > mixedPcm.length) continue;
    const value = mixedPcm.readInt16LE(offset);
    sumSquares += value * value;
    counted++;
  }
  return counted === 0 ? 0 : Math.sqrt(sumSquares / counted);
}

describe("mixWindow", () => {
  it("places a single speaker's frame at the correct offset and leaves the rest silent", () => {
    const windowMs = 1000;
    const frame: OpusFrame = { data: encodeToneFrame(440), receivedAt: 500 }; // 500ms into the window
    const perUser = new Map([["user1", [frame]]]);

    const mixed = mixWindow(perUser, 0, windowMs);

    const sampleOffset = Math.round((500 / 1000) * SAMPLE_RATE);
    const energyAtFrame = rmsAt(mixed, sampleOffset, FRAME_SIZE);
    const energyBefore = rmsAt(mixed, 0, sampleOffset - 100);
    const energyAfter = rmsAt(mixed, sampleOffset + FRAME_SIZE + 100, SAMPLE_RATE - sampleOffset - FRAME_SIZE - 200);

    assert.ok(energyAtFrame > 1000, `expected strong signal at the frame's position, got ${energyAtFrame}`);
    assert.equal(energyBefore, 0);
    assert.equal(energyAfter, 0);
  });

  it("averages two overlapping speakers instead of summing-then-clipping", () => {
    const frameA: OpusFrame = { data: encodeToneFrame(440, 8000), receivedAt: 0 };
    const frameB: OpusFrame = { data: encodeToneFrame(220, 8000), receivedAt: 0 };

    const soloA = mixWindow(new Map([["userA", [frameA]]]), 0, 200);
    const both = mixWindow(
      new Map([
        ["userA", [frameA]],
        ["userB", [frameB]],
      ]),
      0,
      200,
    );

    const energySolo = rmsAt(soloA, 0, FRAME_SIZE);
    const energyBoth = rmsAt(both, 0, FRAME_SIZE);
    // Both voices should still be audible (not silence) but averaged rather than summed —
    // summing-then-clamping (the old, buggy behavior) would push this well above the solo level
    // and into hard digital clipping; averaging keeps it in the same ballpark as either voice alone.
    assert.ok(energyBoth > energySolo * 0.3, `expected both voices to still be audible, got ${energyBoth} vs solo ${energySolo}`);
    assert.ok(energyBoth < energySolo * 1.5, `expected averaging, not summing — got ${energyBoth} vs solo ${energySolo}`);
  });

  it("does not hard-clip when several loud speakers overlap", () => {
    const speakerCount = 6;
    const perUser = new Map(
      Array.from({ length: speakerCount }, (_, i) => [`user${i}`, [{ data: encodeToneFrame(220 + i * 60, 16000), receivedAt: 0 }]] as const),
    );

    const mixed = mixWindow(perUser, 0, 200);
    let clippedSamples = 0;
    for (let i = 0; i < FRAME_SIZE * CHANNELS; i++) {
      const value = mixed.readInt16LE(i * 2);
      if (value >= 32767 || value <= -32768) clippedSamples++;
    }
    // A handful of coincidental peaks hitting the ceiling is fine; the old sum-then-clamp
    // behavior would pin a large fraction of samples to the ceiling (audible harsh distortion).
    const clippedFraction = clippedSamples / (FRAME_SIZE * CHANNELS);
    assert.ok(clippedFraction < 0.05, `expected minimal hard-clipping, got ${(clippedFraction * 100).toFixed(1)}% of samples pinned to the ceiling`);
  });

  it("glues consecutive frames together despite network jitter in receivedAt", () => {
    // Real packet spacing is ~20ms but jitters a few ms either way; placing each frame at its own
    // wall-clock receivedAt (the old behavior) bakes that jitter in as tiny gaps or overlaps —
    // audible as crackle across a whole clip. Ten frames at 440Hz should decode to one continuous
    // tone with no dips (gaps) or attenuation (overlap-then-averaging) at the frame boundaries.
    const frameCount = 10;
    const frames: OpusFrame[] = [];
    for (let i = 0; i < frameCount; i++) {
      // Nominally 20ms apart, jittered by up to +/-5ms — still within JITTER_TOLERANCE_MS.
      const jitter = i % 2 === 0 ? 4 : -4;
      frames.push({ data: encodeToneFrame(440, 12000), receivedAt: i * 20 + jitter });
    }

    const mixed = mixWindow(new Map([["user1", frames]]), 0, 500);

    // Sample every frame boundary; none should show a dip toward silence or a spike from overlap.
    const boundaryEnergies: number[] = [];
    for (let i = 1; i < frameCount; i++) {
      const boundarySample = i * FRAME_SIZE;
      boundaryEnergies.push(rmsAt(mixed, boundarySample - 20, 40));
    }
    const overallEnergy = rmsAt(mixed, 0, frameCount * FRAME_SIZE);

    for (const energy of boundaryEnergies) {
      assert.ok(energy > overallEnergy * 0.5, `expected no silent gap at a frame boundary, got ${energy} vs overall ${overallEnergy}`);
      assert.ok(energy < overallEnergy * 1.5, `expected no overlap-attenuation at a frame boundary, got ${energy} vs overall ${overallEnergy}`);
    }
  });

  it("resyncs to wall-clock time after a real pause between talk spurts", () => {
    const spurtA: OpusFrame = { data: encodeToneFrame(440, 12000), receivedAt: 0 };
    const spurtB: OpusFrame = { data: encodeToneFrame(440, 12000), receivedAt: 5000 }; // long pause, not jitter

    const mixed = mixWindow(new Map([["user1", [spurtA, spurtB]]]), 0, 6000);

    const energyAtA = rmsAt(mixed, 0, FRAME_SIZE);
    const energyAtB = rmsAt(mixed, Math.round(5000 / 1000 * SAMPLE_RATE), FRAME_SIZE);
    const energyBetween = rmsAt(mixed, FRAME_SIZE + 100, Math.round(5000 / 1000 * SAMPLE_RATE) - FRAME_SIZE - 200);

    assert.ok(energyAtA > 1000, "expected the first spurt to be audible at its own position");
    assert.ok(energyAtB > 1000, "expected the second spurt to be audible 5s later, not glued to the first");
    assert.equal(energyBetween, 0, "expected silence during the pause between spurts");
  });

  it("produces exactly windowMs of silence when there are no frames at all", () => {
    const mixed = mixWindow(new Map(), 0, 500);
    assert.equal(mixed.length, Math.round((SAMPLE_RATE * 500) / 1000) * CHANNELS * 2);
    assert.ok(mixed.every((byte) => byte === 0));
  });
});
