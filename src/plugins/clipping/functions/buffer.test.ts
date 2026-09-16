import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UserOpusRingBuffer } from "./buffer.js";

describe("UserOpusRingBuffer", () => {
  it("keeps frames within the max age", () => {
    const buffer = new UserOpusRingBuffer(5000);
    buffer.push(Buffer.from([1]), 1000);
    buffer.push(Buffer.from([2]), 3000);
    buffer.push(Buffer.from([3]), 6000);

    const frames = buffer.getFramesInWindow(10_000, 6000);
    assert.deepEqual(
      frames.map((f) => f.receivedAt),
      [1000, 3000, 6000],
    );
  });

  it("prunes frames older than the buffer's max age on push", () => {
    const buffer = new UserOpusRingBuffer(5000); // 5s ring
    buffer.push(Buffer.from([1]), 0);
    buffer.push(Buffer.from([2]), 2000);
    buffer.push(Buffer.from([3]), 8000); // now=8000, cutoff=3000 -> drops frames at 0 and 2000

    assert.deepEqual(
      buffer.getFramesInWindow(10_000, 8000).map((f) => f.receivedAt),
      [8000],
    );
  });

  it("getFramesInWindow only returns frames inside the requested window, not the full buffer", () => {
    const buffer = new UserOpusRingBuffer(300_000); // 5 min ring
    buffer.push(Buffer.from([1]), 0);
    buffer.push(Buffer.from([2]), 100_000);
    buffer.push(Buffer.from([3]), 290_000);

    // Asking for just the last 30s at t=290_000 should only return the last frame.
    const frames = buffer.getFramesInWindow(30_000, 290_000);
    assert.deepEqual(
      frames.map((f) => f.receivedAt),
      [290_000],
    );
  });

  it("reports empty correctly and returns nothing for an empty buffer", () => {
    const buffer = new UserOpusRingBuffer(5000);
    assert.equal(buffer.isEmpty(), true);
    assert.deepEqual(buffer.getFramesInWindow(5000, Date.now()), []);
  });
});
