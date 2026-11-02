import { test } from "node:test";
import assert from "node:assert/strict";
import { clampPauseMinutes, RAID_COOLDOWN_MS, RaidDetector } from "./raid.js";

const opts = { threshold: 3, windowSeconds: 60 };

test("trips when the threshold is reached inside the window", () => {
  const raid = new RaidDetector();
  assert.equal(raid.record("g", "abc", 0, opts), false);
  assert.equal(raid.record("g", "abc", 10_000, opts), false);
  assert.equal(raid.record("g", "abc", 20_000, opts), true);
});

test("joins spread wider than the window don't trip", () => {
  const raid = new RaidDetector();
  assert.equal(raid.record("g", "abc", 0, opts), false);
  assert.equal(raid.record("g", "abc", 40_000, opts), false);
  assert.equal(raid.record("g", "abc", 70_000, opts), false);
  assert.equal(raid.record("g", "abc", 80_000, opts), true);
});

test("each invite key counts separately", () => {
  const raid = new RaidDetector();
  raid.record("g", "a", 0, opts);
  raid.record("g", "b", 1, opts);
  assert.equal(raid.record("g", "a", 2, opts), false);
});

test("a guild can't trip again during the cooldown", () => {
  const raid = new RaidDetector();
  for (let i = 0; i < 3; i++) raid.record("g", "abc", i, opts);
  for (let i = 0; i < 3; i++) assert.equal(raid.record("g", "abc", 1000 + i, opts), false);
  const later = RAID_COOLDOWN_MS + 10_000;
  raid.record("g", "abc", later, opts);
  raid.record("g", "abc", later + 1, opts);
  assert.equal(raid.record("g", "abc", later + 2, opts), true);
});

test("forget drops a guild", () => {
  const raid = new RaidDetector();
  raid.record("g", "abc", 0, opts);
  assert.equal(raid.size, 1);
  raid.forget("g");
  assert.equal(raid.size, 0);
});

test("pause length is clamped to 15 minutes – 24 hours", () => {
  assert.equal(clampPauseMinutes(5), 15);
  assert.equal(clampPauseMinutes(60), 60);
  assert.equal(clampPauseMinutes(5000), 1440);
  assert.equal(clampPauseMinutes(Number.NaN), 60);
});
