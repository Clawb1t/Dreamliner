import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB, see permissionRoles.test.ts for why this must be set before any
// getDb() call and why each test file gets its own process under Node's test runner.
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-ai-gate-test-"));
const dbPath = join(scratchDir, "test.db");
process.env.DATABASE_URL = `file:${dbPath}`;
// No OpenAI key, so every AI call below fails: that's what the refund tests rely on.
delete process.env.OPENAI_API_KEY;

const { runMigrations } = await import("../../scripts/migrate.js");
runMigrations();

const { consumeAiGate } = await import("./gate.js");
const { AI_FREE_USES_LIMIT, getAiGateStatus } = await import("./usage.js");
const { generateAiCopy } = await import("../../bridge/webAi.js");
const { upsertDreamlinerOne } = await import("../../bridge/dreamlinerOne.js");
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

describe("consumeAiGate", () => {
  it(`allows exactly AI_FREE_USES_LIMIT (${AI_FREE_USES_LIMIT}) free generations for a non-One guild, then blocks`, async () => {
    for (let i = 0; i < AI_FREE_USES_LIMIT; i += 1) {
      const result = await consumeAiGate("guild-free-1");
      assert.equal(result.ok, true);
    }

    const blocked = await consumeAiGate("guild-free-1");
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.status, 403);
      assert.equal(blocked.freeUsesRemaining, 0);
    }
  });

  it("reports the real number of free uses left after charging one", async () => {
    const result = await consumeAiGate("guild-free-2");
    assert.equal(result.ok, true);
    assert.equal(result.freeUsesRemaining, AI_FREE_USES_LIMIT - 1);
    assert.equal((await getAiGateStatus("guild-free-2")).freeUsesRemaining, AI_FREE_USES_LIMIT - 1);
  });

  it("never blocks a Dreamliner One guild", async () => {
    await upsertDreamlinerOne({ guildId: "guild-one-1", actorId: "tester", expiresAt: null });

    for (let i = 0; i < 3; i += 1) {
      const result = await consumeAiGate("guild-one-1");
      assert.equal(result.ok, true);
    }
  });
});

describe("Autopilot refunds", () => {
  it("gives the free use back when the copywriting call fails", async () => {
    const before = (await getAiGateStatus("guild-refund-1")).freeUsesRemaining;
    const result = await generateAiCopy("guild-refund-1", { task: "welcome_join_message", context: {} });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 502);
      assert.equal(result.freeUsesRemaining, before);
    }
    assert.equal((await getAiGateStatus("guild-refund-1")).freeUsesRemaining, before);
  });

  it("doesn't touch the free-use count of a Dreamliner One guild when a call fails", async () => {
    await consumeAiGate("guild-refund-one");
    await upsertDreamlinerOne({ guildId: "guild-refund-one", actorId: "tester", expiresAt: null });
    const result = await generateAiCopy("guild-refund-one", { task: "welcome_join_message", context: {} });
    assert.equal(result.ok, false);
    const { getFreeUsesRemaining } = await import("./usage.js");
    assert.equal(await getFreeUsesRemaining("guild-refund-one"), AI_FREE_USES_LIMIT - 1);
  });
});
