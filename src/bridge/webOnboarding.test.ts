import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB, set before any getDb() call (see permissionRoles.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-onboarding-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../scripts/migrate.js");
runMigrations();

const {
  claimWelcomeMessage,
  cleanEntityName,
  getOnboardingState,
  isConfigCustomised,
  normalizeAnswers,
  updateOnboardingState,
} = await import("./webOnboarding.js");
const { bucketFor } = await import("./rateLimit.js");
const { getDb } = await import("../db/client.js");
const { guildConfigs } = await import("../db/schema.js");

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

const USER = "900000000000000001";

function storeConfig(guildId: string, user: unknown) {
  getDb()
    .insert(guildConfigs)
    .values({ guildId, configJson: "{}", userConfigJson: JSON.stringify(user), updatedAt: new Date(), updatedBy: "system:auto-onboard" })
    .run();
}

describe("isConfigCustomised", () => {
  it("treats an auto-provisioned or system-only config as untouched", () => {
    assert.equal(isConfigCustomised(null), false);
    assert.equal(isConfigCustomised("{}"), false);
    assert.equal(isConfigCustomised(JSON.stringify({ emojis: { success: "x" } })), false);
    assert.equal(isConfigCustomised(JSON.stringify({ plugins: { stats: { enabled: true } } })), false);
    assert.equal(isConfigCustomised("not json"), false);
  });

  it("spots real setup: a plugin on, plugin settings, or a server setting", () => {
    assert.equal(isConfigCustomised(JSON.stringify({ plugins: { tickets: { enabled: true } } })), true);
    assert.equal(isConfigCustomised(JSON.stringify({ plugins: { tags: { config: { can_create: true } } } })), true);
    assert.equal(isConfigCustomised(JSON.stringify({ server_log_channel_id: "123" })), true);
  });
});

describe("onboarding state", () => {
  it("shows the flow on a brand new server and hides it on a customised one", () => {
    const fresh = getOnboardingState("100000000000000001");
    assert.equal(fresh.status, "pending");
    assert.equal(fresh.implicit, true);
    assert.equal(fresh.showOnOpen, true);

    storeConfig("100000000000000002", { plugins: { automod: { enabled: true } } });
    const existing = getOnboardingState("100000000000000002");
    assert.equal(existing.status, "completed");
    assert.equal(existing.showOnOpen, false);

    storeConfig("100000000000000003", {});
    assert.equal(getOnboardingState("100000000000000003").showOnOpen, true);
  });

  it("starts, resumes, skips, completes and resets", () => {
    const guild = "100000000000000010";
    const started = updateOnboardingState(guild, USER, { action: "start" });
    assert.ok(started.ok);
    assert.equal(started.state.status, "in_progress");
    assert.equal(started.state.step, "welcome");
    assert.equal(started.state.startedBy, USER);

    const moved = updateOnboardingState(guild, USER, {
      action: "progress",
      step: "goals",
      answers: { purposes: ["community", "community", "Bad Id!"], size: "medium", goals: ["safety"] },
    });
    assert.ok(moved.ok);
    // Resume: the next read lands on the same step with the same answers.
    const resumed = getOnboardingState(guild);
    assert.equal(resumed.step, "goals");
    assert.equal(resumed.showOnOpen, true);
    assert.deepEqual(resumed.answers.purposes, ["community"]);
    assert.equal(resumed.answers.size, "medium");

    const skipped = updateOnboardingState(guild, USER, { action: "skip" });
    assert.ok(skipped.ok);
    assert.equal(skipped.state.status, "skipped");
    assert.equal(skipped.state.showOnOpen, false);
    assert.equal(skipped.state.step, "goals");

    const done = updateOnboardingState(guild, USER, { action: "complete", answers: { plugins: ["automod", "welcome_message"] } });
    assert.ok(done.ok);
    assert.equal(done.state.status, "completed");
    assert.equal(done.state.completedBy, USER);
    assert.equal(done.state.step, "done");
    assert.deepEqual(done.state.answers.plugins, ["automod", "welcome_message"]);

    // Run setup again keeps the old answers to start from.
    const again = updateOnboardingState(guild, USER, { action: "start", step: "purpose" });
    assert.ok(again.ok);
    assert.equal(again.state.step, "purpose");
    assert.deepEqual(again.state.answers.plugins, ["automod", "welcome_message"]);

    // Skipping that re-run leaves the server completed, not skipped.
    const skippedRedo = updateOnboardingState(guild, USER, { action: "skip" });
    assert.ok(skippedRedo.ok);
    assert.equal(skippedRedo.state.status, "completed");
    assert.equal(skippedRedo.state.showOnOpen, false);

    const reset = updateOnboardingState(guild, USER, { action: "reset" });
    assert.ok(reset.ok);
    assert.equal(reset.state.status, "pending");
    assert.equal(reset.state.implicit, false);
    assert.equal(reset.state.showOnOpen, true);
    assert.deepEqual(reset.state.answers.plugins, []);
  });

  it("rejects unknown actions and ignores unknown steps", () => {
    const bad = updateOnboardingState("100000000000000011", USER, { action: "explode" });
    assert.equal(bad.ok, false);
    const odd = updateOnboardingState("100000000000000011", USER, { action: "progress", step: "nowhere" });
    assert.ok(odd.ok);
    assert.equal(odd.state.step, "welcome");
  });

  it("normalizes answers", () => {
    assert.deepEqual(normalizeAnswers(null), { purposes: [], size: null, goals: [], plugins: [], off: [] });
    assert.equal(normalizeAnswers({ size: "huge" }).size, null);
    assert.equal(normalizeAnswers({ plugins: Array.from({ length: 200 }, (_, i) => `p${i}`) }).plugins.length, 80);
  });
});

describe("claimWelcomeMessage", () => {
  it("lets the welcome message go out once per server, ever", () => {
    const guild = "100000000000000020";
    assert.equal(claimWelcomeMessage(guild), true);
    assert.equal(claimWelcomeMessage(guild), false);
    assert.equal(claimWelcomeMessage(guild), false);
    // Claiming doesn't change what the dashboard shows: a new server still gets the flow.
    assert.equal(getOnboardingState(guild).showOnOpen, true);
  });

  it("still claims once for a server that already has setup state, and keeps that state", () => {
    const guild = "100000000000000021";
    updateOnboardingState(guild, USER, { action: "complete" });
    assert.equal(claimWelcomeMessage(guild), true);
    assert.equal(claimWelcomeMessage(guild), false);
    assert.equal(getOnboardingState(guild).status, "completed");
  });
});

describe("onboarding helpers", () => {
  it("cleans channel and role names", () => {
    assert.equal(cleanEntityName("text", "  Mod Logs! "), "mod-logs");
    assert.equal(cleanEntityName("category", "Support Tickets"), "Support Tickets");
    assert.equal(cleanEntityName("role", "Verified"), "Verified");
    assert.equal(cleanEntityName("text", "!!!"), null);
    assert.equal(cleanEntityName("role", 5), null);
  });

  it("puts Create one for me in the send bucket", () => {
    assert.equal(bucketFor("POST", "/bridge/guilds/123456789012345678/onboarding/create"), "send");
    assert.equal(bucketFor("PUT", "/bridge/guilds/123456789012345678/onboarding"), "write");
    assert.equal(bucketFor("GET", "/bridge/guilds/123456789012345678/onboarding"), "read");
  });
});
