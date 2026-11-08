import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB (see permissionRoles.test.ts): must be set before any getDb() call.
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-server-autopilot-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../../scripts/migrate.js");
runMigrations();

const store = await import("./store.js");
const { consumeFreeAiUse, getAiGateStatus, AI_FREE_USES_LIMIT } = await import("../ai/usage.js");
const { getDb } = await import("../../db/client.js");
const { initialSteps } = await import("./build.js");

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

const GUILD = "123456789012345678";

describe("server autopilot store", () => {
  it("marks interrupted builds failed, keeping finished steps and ids", async () => {
    const steps = initialSteps();
    steps[0]!.status = "done";
    steps[1]!.status = "running";
    const build = store.insertBuild({
      guildId: GUILD,
      kind: "build",
      status: "running",
      steps: JSON.stringify(steps),
      errors: "[]",
      idMap: JSON.stringify({ roles: { mod: "1" }, channels: {} }),
      template: JSON.stringify({ id: "g1_a" }),
      createdBy: "1",
      createdAt: new Date(),
    });
    assert.equal(store.activeBuild(GUILD)?.id, build.id);
    await store.failInterruptedJobs();
    const row = store.getBuild(GUILD, build.id)!;
    assert.equal(row.status, "failed");
    const after = JSON.parse(row.steps) as Array<{ status: string }>;
    assert.equal(after[0]!.status, "done");
    assert.equal(after[1]!.status, "failed");
    assert.equal(after[2]!.status, "skipped");
    assert.match(JSON.parse(row.errors)[0].message, /restarted during the build/);
    assert.deepEqual(JSON.parse(row.idMap).roles, { mod: "1" });
    assert.equal(store.activeBuild(GUILD), null);
    assert.equal(store.lastUnfinishedBuild(GUILD, "g1_a", build.id + 1)?.id, build.id);
  });

  it("refunds a charged generation that produced nothing", async () => {
    assert.ok(await consumeFreeAiUse(GUILD));
    const before = (await getAiGateStatus(GUILD)).freeUsesRemaining;
    const gen = store.insertGeneration({ guildId: GUILD, answers: "{}", charged: true, createdBy: "1" });
    assert.equal(store.runningGeneration(GUILD)?.id, gen.id);
    await store.failInterruptedJobs();
    assert.equal(store.getGeneration(GUILD, gen.id)!.status, "failed");
    assert.equal((await getAiGateStatus(GUILD)).freeUsesRemaining, Math.min(AI_FREE_USES_LIMIT, before + 1));
  });

  it("keeps the newest 10 backups and 15 generations", () => {
    for (let i = 0; i < 12; i++) {
      store.insertBackup({ guildId: GUILD, reason: "manual", structure: "{}", createdBy: "1", createdAt: new Date(Date.now() + i) });
    }
    assert.equal(store.listBackups(GUILD).length, 10);
    for (let i = 0; i < 17; i++) store.insertGeneration({ guildId: GUILD, answers: "{}", charged: false, createdBy: "1" });
    assert.equal(store.listGenerations(GUILD).length, 15);
  });
});
