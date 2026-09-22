import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pearson, strengthOf } from "./correlation.js";

describe("pearson", () => {
  it("returns 1 for a perfectly linear positive relationship", () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8];
    const y = [2, 4, 6, 8, 10, 12, 14, 16];
    assert.equal(pearson(x, y), 1);
  });

  it("returns -1 for a perfectly linear inverse relationship", () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8];
    const y = [16, 14, 12, 10, 8, 6, 4, 2];
    assert.equal(pearson(x, y), -1);
  });

  it("returns null when either series has zero variance", () => {
    const x = [5, 5, 5, 5, 5, 5, 5, 5];
    const y = [1, 2, 3, 4, 5, 6, 7, 8];
    assert.equal(pearson(x, y), null);
  });

  it("returns null with fewer than the minimum number of points", () => {
    const x = [1, 2, 3];
    const y = [1, 2, 3];
    assert.equal(pearson(x, y), null);
  });

  it("returns something close to 0 for unrelated series", () => {
    const x = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3];
    const y = [8, 8, 3, 4, 9, 6, 4, 3, 2, 3];
    const r = pearson(x, y);
    assert.ok(r != null);
    assert.ok(Math.abs(r) < 0.6, `expected a weak correlation, got ${r}`);
  });
});

describe("strengthOf", () => {
  it("classifies by absolute magnitude, not sign", () => {
    assert.equal(strengthOf(0.8), "strong");
    assert.equal(strengthOf(-0.8), "strong");
    assert.equal(strengthOf(0.4), "moderate");
    assert.equal(strengthOf(0.2), "weak");
    assert.equal(strengthOf(0.05), "none");
    assert.equal(strengthOf(null), "insufficient_data");
  });
});
