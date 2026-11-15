import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { banEvasionMatches, directAltLinks } from "./altMatching.js";
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

const bans = (entries: [string, number][]) => new Map(entries.map(([id, caseId]) => [id, { caseId, type: "ban" }]));

describe("directAltLinks", () => {
  it("links exact IP as high and same subnet as medium", () => {
    const rows = [
      row({ userId: "new", ipAddress: "10.0.0.5" }),
      row({ userId: "exact", ipAddress: "10.0.0.5" }),
      row({ userId: "subnet", ipAddress: "10.0.0.99" }),
      row({ userId: "other", ipAddress: "99.9.9.9" }),
    ];
    const links = directAltLinks(rows, [], "new");
    const byId = new Map(links.map((l) => [l.userId, l.tier]));
    assert.equal(byId.get("exact"), "high");
    assert.equal(byId.get("subnet"), "medium");
    assert.equal(byId.has("other"), false);
  });

  it("does not chain through a third account", () => {
    // new ~ middle (subnet), middle ~ far (exact IP of a different range): far is not a direct link.
    const rows = [
      row({ userId: "new", ipAddress: "10.0.0.5" }),
      row({ userId: "middle", ipAddress: "10.0.0.6", city: "X" }),
      row({ userId: "far", ipAddress: "20.0.0.1", city: "Y" }),
    ];
    const links = directAltLinks(rows, [], "new");
    assert.deepEqual(links.map((l) => l.userId), ["middle"]);
  });

  it("skips dismissed pairs", () => {
    const rows = [row({ userId: "new" }), row({ userId: "b" })];
    assert.deepEqual(directAltLinks(rows, [{ userIdA: "b", userIdB: "new" }], "new"), []);
  });
});

describe("banEvasionMatches", () => {
  it("matches a direct high or medium link with an active ban", () => {
    const rows = [
      row({ userId: "new", ipAddress: "10.0.0.5" }),
      row({ userId: "banned", ipAddress: "10.0.0.5" }),
      row({ userId: "clean", ipAddress: "10.0.0.5" }),
    ];
    const matches = banEvasionMatches(directAltLinks(rows, [], "new"), bans([["banned", 42]]));
    assert.deepEqual(matches, [{ bannedUserId: "banned", caseId: 42, caseType: "ban", tier: "high" }]);
  });

  it("never alerts on a city-only link", () => {
    const rows = [
      row({ userId: "new", ipAddress: "10.0.0.5", city: "Paris" }),
      row({ userId: "banned", ipAddress: "88.1.1.1", city: "Paris" }),
    ];
    const links = directAltLinks(rows, [], "new");
    assert.equal(links[0]?.tier, "low");
    assert.deepEqual(banEvasionMatches(links, bans([["banned", 7]])), []);
  });

  it("ignores linked accounts with no active ban", () => {
    const rows = [row({ userId: "new" }), row({ userId: "b" })];
    assert.deepEqual(banEvasionMatches(directAltLinks(rows, [], "new"), new Map()), []);
  });

  it("sorts the strongest match first", () => {
    const rows = [
      row({ userId: "new", ipAddress: "10.0.0.5" }),
      row({ userId: "medium", ipAddress: "10.0.0.9" }),
      row({ userId: "high", ipAddress: "10.0.0.5" }),
    ];
    const matches = banEvasionMatches(directAltLinks(rows, [], "new"), bans([["medium", 50], ["high", 3]]));
    assert.deepEqual(matches.map((m) => m.bannedUserId), ["high", "medium"]);
  });
});
