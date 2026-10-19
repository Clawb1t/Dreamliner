import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB, set before anything opens a connection (the worker threads inherit it).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-offload-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../scripts/migrate.js");
runMigrations();
const { getDb } = await import("../db/client.js");
const { offloadStats, stopOffloadWorkers } = await import("./offload.js");
const globalQueries = await import("../plugins/stats/functions/globalQueries.js");
const voice = await import("../plugins/stats/functions/voice.js");

const sqlite = (getDb() as unknown as { session: { client: Database.Database } }).session.client;

after(async () => {
  await stopOffloadWorkers();
  try {
    sqlite.close();
  } catch {
    /* best effort */
  }
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("offloaded queries", () => {
  it("run on a worker thread and return the same answer as the main thread", async () => {
    const insert = sqlite.prepare("insert into user_message_counts (user_id, count) values (?, ?)");
    sqlite.transaction(() => {
      for (let i = 1; i <= 50; i++) insert.run(`10000000000000000${i}`, i * 10);
    })();

    const viaWorker = await globalQueries.computeGlobalMessagesTotal();
    assert.equal(viaWorker, (50 * 51 * 10) / 2);
    assert.equal(await globalQueries.computeGlobalActiveMessagers(), 50);
  });

  it("returns structured results (arrays of rows) intact", async () => {
    const insert = sqlite.prepare(
      "insert into guild_stats_user_voice_daily (guild_id, user_id, stat_date, minutes, seconds, sessions) values (?, ?, ?, ?, ?, ?)",
    );
    const today = new Date().toISOString().slice(0, 10);
    sqlite.transaction(() => {
      for (let i = 1; i <= 30; i++) insert.run("900000000000000001", `2000000000000000${String(i).padStart(3, "0")}`, today, i, i * 60, 1);
    })();
    const top = await voice.getTopVoiceUsers("900000000000000001", 0, 3);
    assert.deepEqual(top.map((row) => row.userId), ["2000000000000000030", "2000000000000000029", "2000000000000000028"]);
    assert.equal(top[0]!.minutes, 30);
  });

  it("many calls at once all resolve", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => globalQueries.computeGlobalMessagesTotal()));
    assert.ok(results.every((value) => value === (50 * 51 * 10) / 2));
  });

  it("really ran on workers, never silently on the main thread", () => {
    const stats = offloadStats();
    assert.equal(stats.fellBack, 0);
    assert.ok(stats.onWorker >= 15, `only ${stats.onWorker} calls used a worker`);
  });
});
