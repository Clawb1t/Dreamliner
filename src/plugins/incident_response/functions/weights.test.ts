import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeIncidentScore,
  isSeverityIncrease,
  severityFromScore,
  weightForAutomodRule,
  weightForImpersonationScore,
} from "./weights.js";

const THRESHOLDS = { medium: 6, high: 14, critical: 26 };

describe("severityFromScore", () => {
  it("returns low below the medium threshold", () => {
    assert.equal(severityFromScore(0, THRESHOLDS), "low");
    assert.equal(severityFromScore(5, THRESHOLDS), "low");
  });

  it("returns medium/high/critical at each threshold boundary", () => {
    assert.equal(severityFromScore(6, THRESHOLDS), "medium");
    assert.equal(severityFromScore(14, THRESHOLDS), "high");
    assert.equal(severityFromScore(26, THRESHOLDS), "critical");
  });
});

describe("isSeverityIncrease", () => {
  it("is an increase from null (never responded before)", () => {
    assert.equal(isSeverityIncrease("low", null), true);
  });

  it("is not an increase when equal or lower", () => {
    assert.equal(isSeverityIncrease("medium", "medium"), false);
    assert.equal(isSeverityIncrease("low", "high"), false);
  });

  it("is an increase when strictly higher", () => {
    assert.equal(isSeverityIncrease("high", "medium"), true);
  });
});

describe("computeIncidentScore", () => {
  it("sums weights with no bonus for a single source", () => {
    const { riskScore, sourceCount } = computeIncidentScore([
      { weight: 2, source: "automod" },
      { weight: 3, source: "automod" },
    ]);
    assert.equal(riskScore, 5);
    assert.equal(sourceCount, 1);
  });

  it("adds the correlation bonus once two distinct sources appear", () => {
    const { riskScore, sourceCount } = computeIncidentScore([
      { weight: 6, source: "automod" },
      { weight: 9, source: "scam_protect" },
    ]);
    assert.equal(sourceCount, 2);
    assert.equal(riskScore, 6 + 9 + 5);
  });

  it("does not re-apply the bonus per extra signal from a third source", () => {
    const { riskScore } = computeIncidentScore([
      { weight: 6, source: "automod" },
      { weight: 9, source: "scam_protect" },
      { weight: 4, source: "impersonation" },
    ]);
    assert.equal(riskScore, 6 + 9 + 4 + 5);
  });
});

describe("weightForAutomodRule", () => {
  it("weighs slurs higher than generic spam rules", () => {
    assert.ok(weightForAutomodRule("slurs") > weightForAutomodRule("spam"));
  });

  it("falls back to a default weight for an unknown rule id", () => {
    assert.equal(weightForAutomodRule("not_a_real_rule"), 2);
  });
});

describe("weightForImpersonationScore", () => {
  it("scales 0-100 down to 1-10, clamped", () => {
    assert.equal(weightForImpersonationScore(0), 1);
    assert.equal(weightForImpersonationScore(82), 8);
    assert.equal(weightForImpersonationScore(100), 10);
  });
});
