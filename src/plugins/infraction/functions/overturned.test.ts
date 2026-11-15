import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB, set before any getDb() call (see permissionRoles.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-overturned-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../../../scripts/migrate.js");
runMigrations();

const { getDb } = await import("../../../db/client.js");
const { appeals, modCases } = await import("../../../db/schema.js");
const { countQualifyingInfractions } = await import("./escalation.js");
const { countUserInfractions } = await import("./infractions.js");

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
const OTHER_GUILD = "100000000000000009";
const USER = "200000000000000002";
const MOD = "300000000000000003";

function addCase(type: string, guildId = GUILD, active = true): number {
  const row = getDb()
    .insert(modCases)
    .values({ guildId, userId: USER, modId: MOD, type, active, createdAt: new Date() })
    .returning({ id: modCases.id })
    .get();
  return row.id;
}

function addAppeal(caseId: number, status: string, reversed: boolean, guildId = GUILD) {
  const now = new Date();
  getDb()
    .insert(appeals)
    .values({
      guildId,
      userId: USER,
      caseId,
      kind: "case",
      infractionType: "warn",
      answersJson: "[]",
      status,
      reversed,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("cases overturned on appeal", () => {
  const warnA = addCase("warn");
  const warnB = addCase("warn");
  const kick = addCase("kick", GUILD, false); // kicks are created inactive
  const warnDenied = addCase("warn");
  addCase("note");

  it("counts everything before any reversal", async () => {
    assert.equal(await countQualifyingInfractions(GUILD, USER, ["warn", "kick"], 0), 4);
    assert.equal(await countUserInfractions(GUILD, USER, { excludeOverturned: true }), 4);
  });

  it("drops reversed cases from the escalation ladder and review counts", async () => {
    addAppeal(warnA, "approved", true);
    addAppeal(kick, "approved", true);
    addAppeal(warnDenied, "denied", false);
    // Approved but nothing lifted: still counts.
    addAppeal(warnB, "approved", false);

    assert.equal(await countQualifyingInfractions(GUILD, USER, ["warn", "kick"], 0), 2);
    assert.equal(await countQualifyingInfractions(GUILD, USER, ["kick"], 0), 0);
    assert.equal(await countUserInfractions(GUILD, USER, { excludeOverturned: true }), 2);
    assert.equal(await countUserInfractions(GUILD, USER, { excludeOverturned: true, excludeCaseId: warnB }), 1);
    // Default (e.g. /userinfo) keeps the full history.
    assert.equal(await countUserInfractions(GUILD, USER), 4);
  });

  it("ignores a reversed appeal from another guild pointing at the same case id", async () => {
    addCase("warn", OTHER_GUILD);
    addAppeal(warnB, "approved", true, OTHER_GUILD);
    // GUILD warns: warnA (reversed), warnB (still counts), warnDenied (still counts).
    assert.equal(await countQualifyingInfractions(GUILD, USER, ["warn"], 0), 2);
    assert.equal(await countQualifyingInfractions(OTHER_GUILD, USER, ["warn"], 0), 1);
  });
});
