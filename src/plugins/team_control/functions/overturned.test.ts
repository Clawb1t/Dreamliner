import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB, set before any getDb() call (see permissionRoles.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-team-overturned-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../../../scripts/migrate.js");
runMigrations();

const { getDb } = await import("../../../db/client.js");
const { appeals, modCases } = await import("../../../db/schema.js");
const { computeMetrics, computeOverturnedCases } = await import("./activity.js");
const { computePoints, evaluateQuota } = await import("./quota.js");

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
const MOD_A = "300000000000000003";
const MOD_B = "300000000000000004";
const USER = "200000000000000002";

const from = new Date(Date.UTC(2026, 10, 9));
const to = new Date(Date.UTC(2026, 10, 16));
const inRange = new Date(Date.UTC(2026, 10, 12, 12));

function addCase(modId: string, createdAt: Date, guildId = GUILD): number {
  return getDb()
    .insert(modCases)
    .values({ guildId, userId: USER, modId, type: "ban", createdAt })
    .returning({ id: modCases.id })
    .get().id;
}

function addAppeal(caseId: number, reversed: boolean, decidedAt: Date | null, guildId = GUILD) {
  getDb()
    .insert(appeals)
    .values({
      guildId,
      userId: USER,
      caseId,
      kind: "case",
      infractionType: "ban",
      answersJson: "[]",
      status: reversed ? "approved" : "denied",
      reversed,
      createdAt: inRange,
      updatedAt: decidedAt ?? inRange,
      decidedAt,
    })
    .run();
}

describe("cases overturned on appeal per moderator", () => {
  // A case from before the period, overturned during it: counts (the decision date matters).
  addAppeal(addCase(MOD_A, new Date(Date.UTC(2026, 9, 1))), true, inRange);
  addAppeal(addCase(MOD_A, inRange), true, inRange);
  // Denied appeal: no.
  addAppeal(addCase(MOD_A, inRange), false, inRange);
  // Overturned after the period: no.
  addAppeal(addCase(MOD_B, inRange), true, new Date(Date.UTC(2026, 10, 20)));
  // Overturned in range but no decided_at: falls back to updated_at.
  addAppeal(addCase(MOD_B, inRange), true, null);
  // Another guild's appeal: no.
  addAppeal(addCase(MOD_A, inRange, "100000000000000009"), true, inRange, "100000000000000009");

  it("counts by appeal decision time, in milliseconds", () => {
    const counts = computeOverturnedCases(GUILD, [MOD_A, MOD_B], from, to);
    assert.equal(counts.get(MOD_A), 2);
    assert.equal(counts.get(MOD_B), 1);
  });

  it("is only filled in when the toggle asks for it", () => {
    const off = computeMetrics(GUILD, [MOD_A], from, to);
    assert.equal(off.get(MOD_A)!.overturnedCases, undefined);
    const on = computeMetrics(GUILD, [MOD_A, MOD_B], from, to, Date.now(), { includeOverturned: true });
    assert.equal(on.get(MOD_A)!.overturnedCases, 2);
    assert.equal(on.get(MOD_A)!.modActions, 2); // the October case is outside the period
  });

  it("never changes points or quota", () => {
    const weights = { shift_hour: 10, mod_action: 2, ticket: 3, message: 0.1, voice_hour: 2 };
    const base = { shiftMinutes: 120, modActions: 4, ticketsClosed: 1, staffMessages: 10, voiceMinutes: 0, points: null };
    const withOverturned = { ...base, overturnedCases: 50 };
    assert.equal(computePoints(withOverturned, weights), computePoints(base, weights));
    const quota = { shift_hours: 2, mod_actions: 4, tickets: 1, messages: 0, voice_hours: 0 };
    const opts = { pointsMode: false, pointsQuota: 0, excused: false, countsMessages: false };
    assert.deepEqual(evaluateQuota(quota, withOverturned, opts), evaluateQuota(quota, base, opts));
  });
});
