import { test } from "node:test";
import assert from "node:assert/strict";
import { jumpPast, livePosition, nextAfter, normalize, playOrder, type ClockState } from "./clockMath.js";

const tracks = [
  { id: "a", durationMs: 10_000 },
  { id: "b", durationMs: 20_000 },
  { id: "c", durationMs: 30_000 },
];

function state(partial: Partial<ClockState> = {}): ClockState {
  return { currentTrackId: "a", offsetMs: 0, anchorAt: 0, orderSeed: 1, ...partial };
}

test("live position advances within the current track", () => {
  const live = livePosition(state({ offsetMs: 2000 }), tracks, 3000);
  assert.equal(live?.track.id, "a");
  assert.equal(live?.offsetMs, 5000);
});

test("rolls over into the next tracks", () => {
  assert.deepEqual(livePosition(state(), tracks, 10_000), { index: 1, track: tracks[1], offsetMs: 0 });
  assert.equal(livePosition(state(), tracks, 35_000)?.track.id, "c");
  assert.equal(livePosition(state(), tracks, 35_000)?.offsetMs, 5000);
});

test("wraps around the whole station, including many laps at once", () => {
  assert.equal(livePosition(state(), tracks, 60_000)?.track.id, "a");
  const far = livePosition(state(), tracks, 60_000 * 1000 + 15_000);
  assert.equal(far?.track.id, "b");
  assert.equal(far?.offsetMs, 5000);
});

test("starts from the top when the saved track was deleted", () => {
  const live = livePosition(state({ currentTrackId: "gone", offsetMs: 9999 }), tracks, 4000);
  assert.equal(live?.track.id, "a");
  assert.equal(live?.offsetMs, 4000);
});

test("no tracks means nothing is live", () => {
  assert.equal(livePosition(state(), [], 1000), null);
});

test("resume-from-saved: re-anchoring keeps the position, downtime isn't counted", () => {
  const saved = normalize(state(), tracks, 25_000); // b at 15s
  assert.equal(saved.currentTrackId, "b");
  assert.equal(saved.offsetMs, 15_000);
  // Bot was down for an hour: on boot the anchor moves to "now" with the saved offset.
  const booted = { ...saved, anchorAt: 3_600_000 + 25_000 };
  const live = livePosition(booted, tracks, booted.anchorAt + 1000);
  assert.equal(live?.track.id, "b");
  assert.equal(live?.offsetMs, 16_000);
});

test("shuffle is stable for a seed and keeps every track", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: String(i), durationMs: 1000 }));
  const one = playOrder(many, true, 42).map((t) => t.id);
  assert.deepEqual(playOrder(many, true, 42).map((t) => t.id), one);
  assert.notDeepEqual(one, many.map((t) => t.id));
  assert.deepEqual([...one].sort(), many.map((t) => t.id).sort());
  assert.deepEqual(playOrder(many, false, 42), many);
});

test("jumping past a track lands on the next one at 0", () => {
  const jumped = jumpPast(state(), tracks, "c", 5000);
  assert.equal(jumped.currentTrackId, "a");
  assert.equal(jumped.offsetMs, 0);
  assert.equal(jumped.anchorAt, 5000);
  assert.equal(nextAfter(tracks, 0)?.id, "b");
});
