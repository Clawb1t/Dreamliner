import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clusterAltSignals } from "./altMatching.js";
import type { PassportNetworkSignalRow } from "./altSignals.js";

function row(overrides: Partial<PassportNetworkSignalRow> & { userId: string }): PassportNetworkSignalRow {
  return {
    guildId: "g1",
    ipAddress: "1.2.3.4",
    country: null,
    region: null,
    city: null,
    verifiedAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("clusterAltSignals", () => {
  it("clusters accounts sharing the exact same IP as high confidence", () => {
    const rows = [
      row({ userId: "a", ipAddress: "1.2.3.4" }),
      row({ userId: "b", ipAddress: "1.2.3.4" }),
    ];
    const clusters = clusterAltSignals(rows, []);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].confidenceTier, "high");
    // Same exact IP necessarily also falls in the same subnet.
    assert.deepEqual(new Set(clusters[0].signalTypes), new Set(["exact_ip", "subnet"]));
    assert.deepEqual(new Set(clusters[0].memberIds), new Set(["a", "b"]));
  });

  it("clusters accounts on the same subnet as medium confidence", () => {
    const rows = [
      row({ userId: "a", ipAddress: "1.2.3.10" }),
      row({ userId: "b", ipAddress: "1.2.3.200" }),
    ];
    const clusters = clusterAltSignals(rows, []);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].confidenceTier, "medium");
    assert.deepEqual(clusters[0].signalTypes, ["subnet"]);
  });

  it("bumps a subnet match to high when the city also matches", () => {
    const rows = [
      row({ userId: "a", ipAddress: "1.2.3.10", city: "Springfield" }),
      row({ userId: "b", ipAddress: "1.2.3.200", city: "Springfield" }),
    ];
    const clusters = clusterAltSignals(rows, []);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].confidenceTier, "high");
  });

  it("does not cluster accounts with no shared signal", () => {
    const rows = [
      row({ userId: "a", ipAddress: "1.2.3.4" }),
      row({ userId: "b", ipAddress: "9.9.9.9" }),
    ];
    assert.deepEqual(clusterAltSignals(rows, []), []);
  });

  it("excludes a dismissed pair even when they share an IP", () => {
    const rows = [
      row({ userId: "a", ipAddress: "1.2.3.4" }),
      row({ userId: "b", ipAddress: "1.2.3.4" }),
    ];
    const clusters = clusterAltSignals(rows, [{ userIdA: "a", userIdB: "b" }]);
    assert.deepEqual(clusters, []);
  });

  it("chains a shared-IP pair and a shared-subnet pair into one cluster", () => {
    const rows = [
      row({ userId: "a", ipAddress: "1.2.3.4" }),
      row({ userId: "b", ipAddress: "1.2.3.4" }),
      row({ userId: "c", ipAddress: "1.2.3.250" }),
    ];
    const clusters = clusterAltSignals(rows, []);
    assert.equal(clusters.length, 1);
    assert.deepEqual(new Set(clusters[0].memberIds), new Set(["a", "b", "c"]));
    assert.equal(clusters[0].confidenceTier, "high");
  });
});
