import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/**
 * 0145_hangar.sql turns quantity stacks into numbered copies. Applies every migration before it
 * to a temp SQLite file, seeds stacks the old way, then applies 0145 and checks the result.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "drizzle", "migrations");
const HANGAR = "0145_hangar.sql";
const dir = mkdtempSync(join(tmpdir(), "dreamliner-hangar-migration-"));
const db = new Database(join(dir, "test.db"));

after(() => {
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* harmless */
  }
});

function apply(file: string): void {
  db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
}

describe("0145_hangar stack conversion", () => {
  it("turns each stack into that many numbered First Edition copies and drops the old table", () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    assert.ok(files.includes(HANGAR));
    for (const file of files) {
      if (file >= HANGAR) break;
      apply(file);
    }

    const insertType = db.prepare(
      "INSERT INTO plane_card_types (key, name, card_type, subtitle, rarity, image_key, enabled, created_by, created_at, updated_at) VALUES (?, ?, 'plane', '', ?, '', 1, 't', 1, 1)",
    );
    const a = Number(insertType.run("old-a", "Old A", "rare").lastInsertRowid);
    const b = Number(insertType.run("old-b", "Old B", "legendary").lastInsertRowid);
    const unused = Number(insertType.run("old-c", "Old C", "epic").lastInsertRowid);
    const stack = db.prepare("INSERT INTO plane_card_inventory (user_id, plane_type_id, quantity, first_obtained_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    stack.run("u1", a, 3, 1000, 1000);
    stack.run("u2", a, 2, 500, 500);
    stack.run("u1", b, 1, 2000, 2000);
    stack.run("u3", b, 0, 3000, 3000); // empty stacks are dropped

    apply(HANGAR);

    const copies = db
      .prepare("SELECT card_type_id, owner_id, serial, livery, first_edition, obtained_via, minted_at FROM plane_card_copies ORDER BY card_type_id, serial")
      .all() as { card_type_id: number; owner_id: string; serial: number; livery: string; first_edition: number; obtained_via: string; minted_at: number }[];
    const ofA = copies.filter((c) => c.card_type_id === a);
    const ofB = copies.filter((c) => c.card_type_id === b);
    assert.equal(ofA.length, 5);
    assert.equal(ofB.length, 1);
    // Serials are per card in order of first acquisition: u2's older stack gets 1-2.
    assert.deepEqual(ofA.map((c) => [c.serial, c.owner_id]), [[1, "u2"], [2, "u2"], [3, "u1"], [4, "u1"], [5, "u1"]]);
    assert.ok(copies.every((c) => c.livery === "standard" && c.first_edition === 1 && c.obtained_via === "migration"));
    assert.equal(ofA[0]!.minted_at, 500);

    const counters = new Map((db.prepare("SELECT card_type_id, next_serial FROM plane_card_mint_counters").all() as { card_type_id: number; next_serial: number }[]).map((r) => [r.card_type_id, r.next_serial]));
    assert.equal(counters.get(a), 6);
    assert.equal(counters.get(b), 2);
    assert.equal(counters.get(unused), 1);

    const states = db.prepare("SELECT user_id, copies_count, score_version FROM plane_card_user_state ORDER BY user_id").all() as { user_id: string; copies_count: number; score_version: number }[];
    assert.deepEqual(states.map((s) => [s.user_id, s.copies_count, s.score_version]), [["u1", 4, 0], ["u2", 2, 0]]);

    const events = db.prepare("SELECT COUNT(*) AS n FROM plane_card_copy_events WHERE kind = 'mint'").get() as { n: number };
    assert.equal(events.n, 6);

    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    assert.ok(!tables.has("plane_card_inventory"));
    assert.ok(!tables.has("plane_global_settings"));
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM plane_card_packs").get() as { n: number }).n, 3);
  });
});
