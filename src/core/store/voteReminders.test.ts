import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Client } from "discord.js";

// Isolated scratch DB, set before any getDb() call (see permissionRoles.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-reminders-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;
// Reminders only go out from the production bot.
process.env.DREAMLINER_ENV = "prod";

const { runMigrations } = await import("../../scripts/migrate.js");
runMigrations();

const { recordVote } = await import("./credits.js");
const { buildVoteReminder, sendDueVoteReminders, setVoteReminders, voteRemindersEnabled } = await import(
  "./voteReminders.js"
);
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

const HOUR = 3_600_000;

/** A client whose DMs are recorded instead of sent. */
function fakeClient() {
  const sent: string[] = [];
  const client = {
    users: {
      fetch: async (id: string) => ({
        send: async () => {
          sent.push(id);
        },
      }),
    },
  } as unknown as Client;
  return { client, sent };
}

describe("vote reminders", () => {
  it("are on until a member turns them off", () => {
    assert.equal(voteRemindersEnabled("u-default"), true);
    setVoteReminders("u-default", false);
    assert.equal(voteRemindersEnabled("u-default"), false);
    setVoteReminders("u-default", true);
    assert.equal(voteRemindersEnabled("u-default"), true);
  });

  it("go out once, 12 hours after the latest vote, and never for opted-out members", async () => {
    const now = Date.UTC(2026, 8, 28, 12);
    recordVote({ userId: "u-due", votedAt: new Date(now - 12 * HOUR - 5 * 60_000), source: "webhook" });
    recordVote({ userId: "u-early", votedAt: new Date(now - 11 * HOUR), source: "webhook" });
    recordVote({ userId: "u-stale", votedAt: new Date(now - 20 * HOUR), source: "history" });
    recordVote({ userId: "u-off", votedAt: new Date(now - 12 * HOUR - 60_000), source: "webhook" });
    setVoteReminders("u-off", false);
    // Voted twice: the older vote is due, but the newer one isn't yet, so nothing goes out.
    recordVote({ userId: "u-again", votedAt: new Date(now - 13 * HOUR), source: "webhook" });
    recordVote({ userId: "u-again", votedAt: new Date(now - HOUR), source: "webhook" });

    const { client, sent } = fakeClient();
    assert.equal(await sendDueVoteReminders(client, now), 1);
    assert.deepEqual(sent, ["u-due"]);

    const second = fakeClient();
    assert.equal(await sendDueVoteReminders(second.client, now + 60_000), 0, "never sent twice");
  });

  it("are never sent by a local development bot", async () => {
    const now = Date.UTC(2026, 9, 1, 12);
    recordVote({ userId: "u-local", votedAt: new Date(now - 12 * HOUR - 60_000), source: "webhook" });
    process.env.DREAMLINER_ENV = "local";
    try {
      const { client, sent } = fakeClient();
      assert.equal(await sendDueVoteReminders(client, now), 0);
      assert.deepEqual(sent, []);
    } finally {
      process.env.DREAMLINER_ENV = "prod";
    }
    // Nothing was marked as sent locally, so production would still remind this member.
    const { client, sent } = fakeClient();
    assert.equal(await sendDueVoteReminders(client, now), 1);
    assert.deepEqual(sent, ["u-local"]);
  });

  it("have a vote button and a stop button, and no em dashes", () => {
    const payload = buildVoteReminder(130);
    const json = JSON.stringify(payload);
    assert.ok(!json.includes("—"));
    assert.match(json, /top\.gg\/bot/);
    assert.match(json, /dl:votereminder:off/);
    assert.match(json, /130 credits/);
  });
});
