import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB: must be set before any getDb() call.
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-avia-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;
process.env.AVIA_DAILY_ANON = "2";
process.env.AVIA_DAILY_USER = "3";
process.env.AVIA_DAILY_GLOBAL = "6";

const { runMigrations } = await import("../../scripts/migrate.js");
runMigrations();

const { collectSnowflakeRefs, plainSettings } = await import("./diagnostics.js");
const usage = await import("./usage.js");
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
    /* best effort */
  }
});

const C1 = "111111111111111111";
const C2 = "222222222222222222";
const R1 = "333333333333333333";
const U1 = "444444444444444444";

describe("collectSnowflakeRefs", () => {
  it("finds channel and role ids by key, nested and in arrays", () => {
    const refs = collectSnowflakeRefs({
      log_channel_id: C1,
      review: { channel_id: C2, thread: true },
      unverified_role_id: R1,
      grant_role_ids: [R1],
      ignored_channels: [C1],
    });
    assert.deepEqual(
      refs.map((r) => `${r.kind}:${r.path}`),
      ["channel:log_channel_id", "channel:review.channel_id", "role:unverified_role_id", "role:grant_role_ids", "channel:ignored_channels"],
    );
  });

  it("ignores ids under other keys and permission overrides", () => {
    const refs = collectSnowflakeRefs({
      message_id: C1,
      user_ids: [U1],
      overrides: [{ role: R1, config: { can_x: true } }],
      channel_id: "",
    });
    assert.equal(refs.length, 0);
  });

  it("caps how many refs it returns", () => {
    const refs = collectSnowflakeRefs({ channels: Array.from({ length: 80 }, (_, i) => `1${String(i).padStart(17, "0")}`) }, 10);
    assert.equal(refs.length, 10);
  });
});

describe("plainSettings", () => {
  it("keeps short plain values and drops ids, flags and secrets", () => {
    const out = plainSettings({
      enabled_feature: true,
      max: 5,
      mode: "kick",
      log_channel_id: C1,
      can_manage: true,
      webhook_url: "https://example.com",
      api_key: "x",
      long_text: "x".repeat(80),
      nested: { a: 1 },
    });
    assert.deepEqual(out, { enabled_feature: true, max: 5, mode: "kick" });
  });
});

describe("Avia daily usage", () => {
  const now = new Date("2026-11-14T12:00:00Z");
  it("validates subjects", () => {
    assert.ok(usage.validAviaSubject(`user:${U1}`));
    assert.ok(usage.validAviaSubject("ip:0123456789abcdef0123"));
    assert.ok(!usage.validAviaSubject("ip:1.2.3.4"));
    assert.ok(!usage.validAviaSubject("*"));
  });

  it("counts per subject per day and stops at the limit", () => {
    const anon = "ip:aaaaaaaaaaaaaaaaaaaa";
    assert.equal(usage.takeAviaMessage(anon, { peek: true, now }).remaining, 2);
    assert.equal(usage.takeAviaMessage(anon, { now }).remaining, 1);
    assert.equal(usage.takeAviaMessage(anon, { now }).remaining, 0);
    const blocked = usage.takeAviaMessage(anon, { now });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "user");
    // A new UTC day starts fresh.
    assert.equal(usage.takeAviaMessage(anon, { now: new Date("2026-11-15T00:00:01Z") }).allowed, true);
  });

  it("signed-in users get their own limit, and the global cap applies to everyone", () => {
    const user = `user:${U1}`;
    for (let i = 0; i < 3; i++) assert.equal(usage.takeAviaMessage(user, { now }).allowed, true);
    // 2 anon + 3 user = 5 of the global 6 on this day.
    assert.equal(usage.takeAviaMessage("ip:bbbbbbbbbbbbbbbbbbbb", { now }).allowed, true);
    const capped = usage.takeAviaMessage("ip:cccccccccccccccccccc", { now });
    assert.equal(capped.allowed, false);
    assert.equal(capped.reason, "global");
  });

  it("records tokens and deletes a user's rows", () => {
    const user = `user:${U1}`;
    usage.recordAviaTokens(user, 120, now);
    assert.equal(usage.aviaUsageForUser(U1).find((r) => r.day === "2026-11-14")?.tokens, 120);
    assert.equal(usage.deleteAviaUsageForUser(U1), 1);
    assert.equal(usage.aviaUsageForUser(U1).length, 0);
  });
});
