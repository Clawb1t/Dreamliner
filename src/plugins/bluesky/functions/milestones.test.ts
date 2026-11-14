import { test } from "node:test";
import assert from "node:assert/strict";
import { MILESTONE_UNSEEDED, formatMilestone, milestoneAtOrBelow, milestoneToAnnounce, nextMilestone } from "./milestones.js";
import { dayBucket, STATS_DAYS } from "./store.js";

test("milestoneAtOrBelow walks the fixed ladder, then every million", () => {
  assert.equal(milestoneAtOrBelow(0), 0);
  assert.equal(milestoneAtOrBelow(99), 0);
  assert.equal(milestoneAtOrBelow(100), 100);
  assert.equal(milestoneAtOrBelow(249), 100);
  assert.equal(milestoneAtOrBelow(250), 250);
  assert.equal(milestoneAtOrBelow(999), 500);
  assert.equal(milestoneAtOrBelow(1_000), 1_000);
  assert.equal(milestoneAtOrBelow(2_499), 1_000);
  assert.equal(milestoneAtOrBelow(2_500), 2_500);
  assert.equal(milestoneAtOrBelow(49_999), 25_000);
  assert.equal(milestoneAtOrBelow(999_999), 500_000);
  assert.equal(milestoneAtOrBelow(1_000_000), 1_000_000);
  assert.equal(milestoneAtOrBelow(1_999_999), 1_000_000);
  assert.equal(milestoneAtOrBelow(7_300_000), 7_000_000);
  assert.equal(milestoneAtOrBelow(-5), 0);
});

test("nextMilestone is the first milestone strictly above the count", () => {
  assert.equal(nextMilestone(0), 100);
  assert.equal(nextMilestone(100), 250);
  assert.equal(nextMilestone(400), 500);
  assert.equal(nextMilestone(500_000), 1_000_000);
  assert.equal(nextMilestone(999_999), 1_000_000);
  assert.equal(nextMilestone(1_000_000), 2_000_000);
  assert.equal(nextMilestone(2_500_000), 3_000_000);
});

test("milestoneToAnnounce announces only new, highest crossed milestones", () => {
  assert.equal(milestoneToAnnounce(100, 180), null);
  assert.equal(milestoneToAnnounce(100, 250), 250);
  // A jump over several milestones announces just the highest.
  assert.equal(milestoneToAnnounce(100, 1_200), 1_000);
  // Dipping below and climbing back never repeats.
  assert.equal(milestoneToAnnounce(1_000, 990), null);
  assert.equal(milestoneToAnnounce(1_000, 1_010), null);
  // Past a million, every million counts.
  assert.equal(milestoneToAnnounce(1_000_000, 2_000_001), 2_000_000);
  // From zero (seeded under 100) the first milestone is 100.
  assert.equal(milestoneToAnnounce(0, 100), 100);
  // Unseeded feeds never announce.
  assert.equal(milestoneToAnnounce(MILESTONE_UNSEEDED, 50_000), null);
});

test("formatMilestone uses short K / M labels", () => {
  assert.equal(formatMilestone(100), "100");
  assert.equal(formatMilestone(500), "500");
  assert.equal(formatMilestone(1_000), "1K");
  assert.equal(formatMilestone(2_500), "2.5K");
  assert.equal(formatMilestone(250_000), "250K");
  assert.equal(formatMilestone(1_000_000), "1M");
  assert.equal(formatMilestone(12_000_000), "12M");
});

test("dayBucket puts the last 24 hours in the final bucket and drops older than the window", () => {
  const now = Date.UTC(2026, 10, 14, 12);
  const hour = 60 * 60_000;
  assert.equal(dayBucket(now - hour, now), STATS_DAYS - 1);
  assert.equal(dayBucket(now - 25 * hour, now), STATS_DAYS - 2);
  assert.equal(dayBucket(now - (STATS_DAYS * 24 - 1) * hour, now), 0);
  assert.equal(dayBucket(now - STATS_DAYS * 24 * hour, now), null);
  // Clock skew: a slightly future timestamp still counts as today.
  assert.equal(dayBucket(now + hour, now), STATS_DAYS - 1);
});
