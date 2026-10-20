import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB, set before any getDb() call (see appeals/functions/store.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-characters-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../../../scripts/migrate.js");
runMigrations();

const limits = await import("./limits.js");
const store = await import("./store.js");
const { getDb } = await import("../../../db/client.js");

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

const GUILD = "100000000000000001";
const OTHER = "100000000000000002";
const USER = "200000000000000002";

describe("characters limits", () => {
  it("has the free and One caps", () => {
    assert.equal(limits.characterLimit(false), 2);
    assert.equal(limits.characterLimit(true), 25);
    assert.equal(limits.dailyReplyLimit(false), 100);
    assert.equal(limits.dailyReplyLimit(true), 3000);
  });

  it("stops at the free daily cap, refunds, and keeps servers separate", () => {
    for (let i = 0; i < 100; i++) assert.equal(limits.takeReply(GUILD, false), true);
    assert.equal(limits.takeReply(GUILD, false), false);
    assert.equal(limits.usageToday(GUILD, false).today, 100);
    // One raises the cap for the same day.
    assert.equal(limits.takeReply(GUILD, true), true);
    limits.refundReply(GUILD);
    limits.refundReply(GUILD);
    assert.equal(limits.usageToday(GUILD, false).today, 99);
    assert.equal(limits.takeReply(GUILD, false), true);
    assert.equal(limits.takeReply(OTHER, false), true);
    assert.equal(limits.usageToday(OTHER, false).today, 1);
    // A refund never goes below zero.
    limits.refundReply(OTHER);
    limits.refundReply(OTHER);
    assert.equal(limits.usageToday(OTHER, false).today, 0);
  });

  it("tracks tokens alongside replies", () => {
    store.addTokens(OTHER, 120, 40);
    store.addTokens(OTHER, 30, 10);
    const usage = store.getUsage(OTHER);
    assert.equal(usage.tokensIn, 150);
    assert.equal(usage.tokensOut, 50);
  });

  it("applies member cooldowns per character and the member daily cap", () => {
    limits.resetMemberLimitsForTests();
    const now = 1_700_000_000_000;
    const rules = { cooldownSeconds: 5, dailyLimit: 3 };
    assert.equal(limits.checkMemberLimits(GUILD, USER, 1, rules, now), "ok");
    limits.noteMemberReply(GUILD, USER, 1, now);
    assert.equal(limits.checkMemberLimits(GUILD, USER, 1, rules, now + 1000), "cooldown");
    assert.equal(limits.checkMemberLimits(GUILD, USER, 2, rules, now + 1000), "ok", "other characters aren't on cooldown");
    assert.equal(limits.checkMemberLimits(GUILD, USER, 1, rules, now + 6000), "ok");
    limits.noteMemberReply(GUILD, USER, 2, now + 7000);
    limits.noteMemberReply(GUILD, USER, 1, now + 8000);
    assert.equal(limits.checkMemberLimits(GUILD, USER, 3, rules, now + 20_000), "daily");
    assert.equal(limits.checkMemberLimits(GUILD, USER, 3, { cooldownSeconds: 5, dailyLimit: 0 }, now + 20_000), "ok", "0 = no member cap");
  });

  it("stores characters and finds them by role and dedicated channel", () => {
    const created = store.createCharacter(GUILD, USER, {
      name: "Captain Barnacle",
      avatarAssetId: null,
      avatarUrl: null,
      tagline: "",
      personality: "Gruff",
      scenario: "",
      greeting: "",
      exampleDialogue: "",
      replyStyle: "short",
      temperature: 0.9,
      roleColor: null,
      dedicatedChannelIds: ["500000000000000000"],
      allowedChannelIds: [],
      enabled: true,
      reviewStatus: "approved",
      reviewReason: null,
      reviewedAt: null,
    });
    assert.equal(store.countCharacters(GUILD), 1);
    store.setCharacterRole(GUILD, created.id, "111111111111111111");
    assert.equal(store.characterByRole(GUILD, "111111111111111111")?.id, created.id);
    assert.equal(store.charactersByDedicatedChannel(GUILD, "500000000000000000").length, 1);
    assert.equal(store.clearDeletedRole(GUILD, "111111111111111111"), true);
    assert.equal(store.getCharacter(GUILD, created.id)?.roleId, null);
    store.setMemoryReset(created.id, "400000000000000000", new Date(5000));
    assert.equal(store.getMemoryReset(created.id, "400000000000000000")?.getTime(), 5000);
    assert.ok(store.deleteCharacter(GUILD, created.id));
    assert.equal(store.countCharacters(GUILD), 0);
    assert.equal(store.getMemoryReset(created.id, "400000000000000000"), null);
  });
});
