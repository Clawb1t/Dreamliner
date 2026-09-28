import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB, set before any getDb() call (see permissionRoles.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-store-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../../scripts/migrate.js");
runMigrations();

const credits = await import("./credits.js");
const { isValidPurchaseDays, maxAffordableDays, purchaseCost, STORE_PRICING } = await import("./pricing.js");
const { getDreamlinerOneAdminStatus, upsertDreamlinerOne } = await import("../../bridge/dreamlinerOne.js");
const { getDb } = await import("../../db/client.js");

after(() => {
  try {
    (getDb() as unknown as { session: { client: Database.Database } }).session.client.close();
  } catch {
    /* best effort */
  }
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    /* leftover temp dir is harmless */
  }
});

const DAY = 86_400_000;

function vote(userId: string, at: Date, source: "webhook" | "history" = "history") {
  return credits.recordVote({ userId, votedAt: at, source });
}

function earn(userId: string, votes: number) {
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < votes; i++) credits.creditVote(vote(userId, new Date(base + i * DAY)), userId);
}

describe("pricing", () => {
  it("sells days in steps of 2, starting at 2", () => {
    assert.equal(STORE_PRICING.creditsPerVote, 10);
    assert.equal(purchaseCost(2), 40);
    assert.ok(isValidPurchaseDays(2) && isValidPurchaseDays(4) && isValidPurchaseDays(6));
    assert.ok(!isValidPurchaseDays(1) && !isValidPurchaseDays(3) && !isValidPurchaseDays(0) && !isValidPurchaseDays(2.5));
    assert.ok(!isValidPurchaseDays(STORE_PRICING.maxDaysPerPurchase + 2));
  });

  it("rounds an affordable balance down to whole 2-day steps", () => {
    assert.equal(maxAffordableDays(39), 0);
    assert.equal(maxAffordableDays(40), 2);
    assert.equal(maxAffordableDays(119), 4);
    assert.equal(maxAffordableDays(1_000_000), STORE_PRICING.maxDaysPerPurchase);
  });
});

describe("votes", () => {
  it("records the same vote once, even when the webhook and history timestamps differ below a second", () => {
    const first = vote("u-dupe", new Date("2026-02-01T10:00:00.123Z"), "webhook");
    const again = vote("u-dupe", new Date("2026-02-01T10:00:00.987654Z"), "history");
    assert.equal(first, again);
  });

  it("pays each vote exactly once", () => {
    const id = vote("u-once", new Date("2026-02-02T10:00:00Z"));
    assert.equal(credits.creditVote(id, "u-once"), 10);
    assert.equal(credits.creditVote(id, "u-once"), 0);
    assert.equal(credits.getCreditBalance("u-once"), 10);
  });

  it("claims every past vote not paid yet, then nothing more", () => {
    vote("u-claim", new Date("2025-11-01T00:00:00Z"));
    vote("u-claim", new Date("2025-11-02T00:00:00Z"));
    credits.creditVote(vote("u-claim", new Date("2025-11-03T00:00:00Z"), "webhook"), "u-claim");
    assert.equal(credits.countUncreditedVotes("u-claim"), 2);
    assert.deepEqual(credits.claimUncreditedVotes("u-claim"), { votes: 2, credits: 20 });
    assert.deepEqual(credits.claimUncreditedVotes("u-claim"), { votes: 0, credits: 0 });
    assert.equal(credits.getCreditBalance("u-claim"), 30);
  });

  it("never pays one member for another member's vote", () => {
    const id = vote("u-owner", new Date("2026-03-01T00:00:00Z"));
    assert.equal(credits.creditVote(id, "u-someone-else"), 0);
  });
});

describe("buying Dreamliner One", () => {
  it("charges 20 credits a day and grants the days", () => {
    earn("u-buy", 8); // 80 credits
    const now = new Date("2026-04-01T00:00:00Z");
    const result = credits.purchaseOneDays({ userId: "u-buy", guildId: "g-new", days: 4, now });
    assert.equal(result.cost, 80);
    assert.equal(result.balance, 0);
    assert.equal(result.expiresAt.getTime(), now.getTime() + 4 * DAY);
    assert.equal(credits.listLedger("u-buy")[0]!.kind, "purchase");
  });

  it("refuses odd days and balances that can't cover the cost, without charging", () => {
    earn("u-poor", 3); // 30 credits
    assert.throws(() => credits.purchaseOneDays({ userId: "u-poor", guildId: "g-x", days: 3 }), { code: "invalid_days" });
    assert.throws(() => credits.purchaseOneDays({ userId: "u-poor", guildId: "g-x", days: 2 }), {
      code: "insufficient_credits",
    });
    assert.equal(credits.getCreditBalance("u-poor"), 30);
  });

  it("stacks onto an active grant and keeps its note", async () => {
    earn("u-stack", 4); // 40 credits
    // One grants store their expiry to the second.
    const expires = new Date(Math.floor((Date.now() + 10 * DAY) / 1000) * 1000);
    await upsertDreamlinerOne({ guildId: "g-active", actorId: "admin", expiresAt: expires, note: "Partner" });
    const result = credits.purchaseOneDays({ userId: "u-stack", guildId: "g-active", days: 2 });
    assert.equal(result.expiresAt.getTime(), expires.getTime() + 2 * DAY);
    const status = await getDreamlinerOneAdminStatus("g-active");
    assert.equal(status.note, "Partner");
    assert.equal(status.grantedBy, "admin");
  });

  it("starts fresh from now on an expired grant", async () => {
    earn("u-expired", 4);
    await upsertDreamlinerOne({ guildId: "g-expired", actorId: "admin", expiresAt: new Date(Date.now() - DAY) });
    const now = new Date();
    const result = credits.purchaseOneDays({ userId: "u-expired", guildId: "g-expired", days: 2, now });
    assert.equal(result.expiresAt.getTime(), now.getTime() + 2 * DAY);
    assert.equal((await getDreamlinerOneAdminStatus("g-expired")).status, "active");
  });

  it("refuses a server that already has One for good, without charging", async () => {
    earn("u-forever", 4);
    await upsertDreamlinerOne({ guildId: "g-forever", actorId: "admin", expiresAt: null });
    assert.throws(() => credits.purchaseOneDays({ userId: "u-forever", guildId: "g-forever", days: 2 }), {
      code: "one_forever",
    });
    assert.equal(credits.getCreditBalance("u-forever"), 40);
  });
});
