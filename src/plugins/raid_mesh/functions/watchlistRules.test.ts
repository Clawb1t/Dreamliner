import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clampWatchlistHours, isWatchlistEntryLive, watchlistExpiry, watchlistUserIds } from "./watchlistRules.js";

const ID_A = "123456789012345678";
const ID_B = "223456789012345678";

describe("mesh watchlist TTL", () => {
  it("expires after the configured hours", () => {
    const now = Date.UTC(2026, 0, 1);
    const expiresAt = watchlistExpiry(now, 24);
    assert.equal(expiresAt.getTime(), now + 24 * 3_600_000);
    assert.equal(isWatchlistEntryLive({ expiresAt }, now + 23 * 3_600_000), true);
    assert.equal(isWatchlistEntryLive({ expiresAt }, now + 24 * 3_600_000), false);
    assert.equal(isWatchlistEntryLive({ expiresAt }, now + 25 * 3_600_000), false);
  });

  it("clamps hours to 1..168", () => {
    assert.equal(clampWatchlistHours(0), 1);
    assert.equal(clampWatchlistHours(500), 168);
    assert.equal(clampWatchlistHours(Number.NaN), 24);
    assert.equal(clampWatchlistHours(12.4), 12);
  });
});

describe("watchlistUserIds", () => {
  it("keeps unique snowflakes only, capped", () => {
    assert.deepEqual(watchlistUserIds([{ id: ID_A }, { id: ID_A }, { id: "nope" }, { id: ID_B }]), [ID_A, ID_B]);
    assert.deepEqual(watchlistUserIds([{ id: ID_A }, { id: ID_B }], 1), [ID_A]);
  });
});
