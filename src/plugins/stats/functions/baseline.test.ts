import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeBaseline, computeWeekdayAdjustedBaseline, isInsightWorthy } from "./baseline.js";

function dates(count: number, startIso = "2026-01-01"): string[] {
  const start = Date.parse(`${startIso}T12:00:00Z`);
  return Array.from({ length: count }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}

describe("computeBaseline", () => {
  it("returns null when there isn't enough history for even one baseline window", () => {
    const values = [10, 12, 11];
    assert.equal(computeBaseline(values, dates(3), 7), null);
  });

  it("flags a current window well above a stable baseline", () => {
    const baseline = Array.from({ length: 28 }, () => 10);
    const current = Array.from({ length: 7 }, () => 20);
    const values = [...baseline, ...current];
    const result = computeBaseline(values, dates(values.length), 7);
    assert.ok(result);
    assert.equal(result.currentMean, 20);
    assert.equal(result.baselineMean, 10);
    assert.equal(result.deltaPct, 100);
    assert.ok(result.z > 1.5, `expected a strong z-score, got ${result.z}`);
  });

  it("does not fabricate a spike out of a flat, identical series", () => {
    const values = Array.from({ length: 35 }, () => 5);
    const result = computeBaseline(values, dates(values.length), 7);
    assert.ok(result);
    assert.equal(result.deltaPct, 0);
    assert.equal(result.z, 0);
  });

  it("treats a baseline of all zeros with new activity as a 100% delta, not divide-by-zero garbage", () => {
    const values = [...Array.from({ length: 28 }, () => 0), ...Array.from({ length: 7 }, () => 3)];
    const result = computeBaseline(values, dates(values.length), 7);
    assert.ok(result);
    assert.equal(result.deltaPct, 100);
    assert.ok(Number.isFinite(result.z));
  });
});

describe("computeWeekdayAdjustedBaseline", () => {
  it("does not flag a quiet Saturday as anomalous relative to busy weekdays", () => {
    // 6 weeks of data: weekdays busy (50), Saturdays/Sundays quiet (5).
    const values: number[] = [];
    const ds: string[] = [];
    const start = Date.parse("2026-01-05T12:00:00Z"); // a Monday
    for (let i = 0; i < 42; i++) {
      const d = new Date(start + i * 86_400_000);
      const weekday = d.getUTCDay();
      const isWeekend = weekday === 0 || weekday === 6;
      values.push(isWeekend ? 5 : 50);
      ds.push(d.toISOString().slice(0, 10));
    }
    const results = computeWeekdayAdjustedBaseline(values, ds);
    const lastSaturday = results[results.length - 2]; // second-to-last day of a Mon-start 42-day run
    assert.ok(lastSaturday);
    assert.ok(Math.abs(lastSaturday.z) < 1, `expected a normal Saturday to read as normal, got z=${lastSaturday.z}`);
  });

  it("returns null until enough same-weekday samples exist", () => {
    const values = [10, 10, 10, 10, 10, 10, 10, 40];
    const results = computeWeekdayAdjustedBaseline(values, dates(values.length), 3);
    // Day 8 (index 7) is the first day-of-week repeat past the minSameWeekdaySamples floor is only
    // reached after 3 prior same-weekday observations, i.e. week 4 for any given weekday.
    assert.equal(results[7], null);
  });
});

describe("isInsightWorthy", () => {
  it("requires all three gates — statistical, magnitude, and volume", () => {
    assert.equal(isInsightWorthy({ z: 2, deltaPct: 20, currentTotal: 50, minVolumeFloor: 20 }), true);
    assert.equal(isInsightWorthy({ z: 0.5, deltaPct: 20, currentTotal: 50, minVolumeFloor: 20 }), false, "z too low");
    assert.equal(isInsightWorthy({ z: 2, deltaPct: 5, currentTotal: 50, minVolumeFloor: 20 }), false, "delta too small");
    assert.equal(isInsightWorthy({ z: 2, deltaPct: 20, currentTotal: 5, minVolumeFloor: 20 }), false, "volume too low");
  });

  it("suppresses a huge percentage jump on a near-empty server", () => {
    // 2 -> 5 messages is a 150% jump but trivially low volume — must not be insight-worthy.
    assert.equal(isInsightWorthy({ z: 3, deltaPct: 150, currentTotal: 5, minVolumeFloor: 20 }), false);
  });
});
