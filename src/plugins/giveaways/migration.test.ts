/**
 * 0150_giveaways_overhaul.sql: existing giveaways keep working. Old posts stay classic embeds,
 * ended giveaways get a legacy draw row (so they can never be drawn again), entries get a zero
 * paid amount, and the new tables exist. Runs every migration before 0150 on a temp DB, inserts
 * old rows, applies 0150 and reads the result through the store.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-giveaways-migration-"));
const dbPath = join(scratchDir, "test.db");
process.env.DATABASE_URL = `file:${dbPath}`;

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../../drizzle/migrations");
const MIGRATION = "0150_giveaways_overhaul.sql";
const GUILD = "123456789012345678";
const now = Math.floor(Date.now() / 1000);

{
  const db = new Database(dbPath);
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    if (file >= MIGRATION) break;
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  const insert = db.prepare(
    `INSERT INTO giveaways (guild_id, channel_id, message_id, title, prize, status, winner_count, starts_at, ends_at, created_by, created_at, updated_at, ended_at)
     VALUES (?, '223456789012345678', ?, ?, ?, ?, ?, ?, ?, '1', ?, ?, ?)`,
  );
  const ended = Number(insert.run(GUILD, "900000000000000001", "Old ended", "Nitro", "ended", 1, now - 7200, now - 3600, now - 7200, now - 3600, now - 3600).lastInsertRowid);
  const active = Number(insert.run(GUILD, "900000000000000002", "Old active", "Role", "active", 2, now - 600, now + 3600, now - 600, now - 600, null).lastInsertRowid);
  const cancelled = Number(insert.run(GUILD, null, "Old cancelled", "Badge", "cancelled", 1, now - 600, now + 3600, now - 600, now - 300, null).lastInsertRowid);
  const entry = db.prepare("INSERT INTO giveaway_entries (giveaway_id, user_id, weight, entered_at) VALUES (?, ?, ?, ?)");
  entry.run(ended, "300000000000000001", 1, now - 5000);
  entry.run(ended, "300000000000000002", 2.5, now - 5000);
  entry.run(active, "300000000000000003", 1, now - 500);
  db.prepare("INSERT INTO giveaway_winners (giveaway_id, user_id, status, selected_at) VALUES (?, ?, 'won', ?)").run(ended, "300000000000000002", now - 3600);
  db.exec(readFileSync(join(MIGRATIONS, MIGRATION), "utf8"));
  db.close();
  void cancelled;
}

const store = await import("./functions/store.js");
const { drawWinners } = await import("./functions/draw.js");
const { getDb } = await import("../../db/client.js");

after(() => {
  try {
    (getDb() as unknown as { session: { client: Database.Database } }).session.client.close();
  } catch {
    /* best effort */
  }
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("0150 giveaways migration", () => {
  it("keeps old posts as embeds with the new fields defaulted", async () => {
    const all = await store.listGiveaways(GUILD);
    assert.equal(all.length, 3);
    for (const g of all) {
      assert.equal(g.messageFormat, "embed");
      assert.equal(g.recurrence, "none");
      assert.equal(g.minMessages, 0);
      assert.equal(g.sponsor, "");
      assert.equal(g.hostId, null);
    }
    const cancelled = all.find((g) => g.status === "cancelled");
    assert.ok(cancelled?.cancelledAt);
  });

  it("records a legacy draw for ended giveaways so they're never drawn again", async () => {
    const ended = (await store.listGiveaways(GUILD, { status: "ended" }))[0]!;
    const draw = await store.getInitialDraw(ended.id);
    assert.ok(draw);
    assert.equal(draw.seed, null);
    assert.equal(draw.poolSize, 2);
    assert.equal(draw.totalWeight, 3.5);
    assert.deepEqual(draw.pickedUserIds, ["300000000000000002"]);
    const again = await drawWinners(ended);
    assert.equal(again.alreadyDrawn, true);
    assert.equal((await store.listWinners(ended.id)).length, 1);
  });

  it("leaves running giveaways drawable, with entries that paid nothing", async () => {
    const active = (await store.listGiveaways(GUILD, { status: "active" }))[0]!;
    assert.equal(await store.getInitialDraw(active.id), null);
    const [entry] = await store.listEntries(active.id);
    assert.equal(entry?.paid, 0);
    const result = await drawWinners(active);
    assert.deepEqual(result.winnerIds, ["300000000000000003"]);
  });

  it("creates the blacklist and timeline tables", async () => {
    await store.addToBlacklist({ guildId: GUILD, userId: "300000000000000009", createdBy: "1" });
    assert.equal(await store.isBlacklisted(GUILD, "300000000000000009"), true);
    await store.addEvent(1, "edited", "1", "Changed prize");
    assert.equal((await store.listEvents(1)).length, 1);
  });
});
