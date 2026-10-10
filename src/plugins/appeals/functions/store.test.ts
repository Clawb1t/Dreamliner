import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB, set before any getDb() call (see permissionRoles.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-appeals-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../../../scripts/migrate.js");
runMigrations();

const store = await import("./store.js");
const { getDb } = await import("../../../db/client.js");

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
const USER = "200000000000000002";

function newAppeal(caseId: number | null = 7, userId = USER) {
  return store.createAppeal({
    guildId: GUILD,
    userId,
    caseId,
    infractionType: caseId === null ? null : "ban",
    caseSnapshot:
      caseId === null
        ? null
        : { type: "ban", reason: "spam", modId: "300000000000000003", active: true, createdAt: new Date().toISOString(), expiresAt: null },
    formId: "form",
    formName: "Appeal form",
    answers: [{ questionId: "q1", label: "Why?", answer: "I won't spam again" }],
  });
}

describe("appeals store", () => {
  it("creates a pending appeal with a submitted event", () => {
    const appeal = newAppeal();
    assert.equal(appeal.status, "pending");
    assert.equal(appeal.kind, "case");
    const events = store.listEvents(appeal.id, true);
    assert.deepEqual(events.map((event) => event.kind), ["submitted"]);
  });

  it("marks appeals without a case as manual", () => {
    assert.equal(newAppeal(null).kind, "manual");
  });

  it("only lets one decision win", () => {
    const appeal = newAppeal();
    const first = store.transitionAppeal(GUILD, appeal.id, ["pending", "needs_info"], "approved", { reviewerId: "a" });
    const second = store.transitionAppeal(GUILD, appeal.id, ["pending", "needs_info"], "denied", { reviewerId: "b" });
    assert.equal(first?.status, "approved");
    assert.equal(second, null);
    assert.equal(store.getAppeal(GUILD, appeal.id)?.reviewerId, "a");
  });

  it("won't transition an appeal from another guild", () => {
    const appeal = newAppeal();
    assert.equal(store.transitionAppeal("999999999999999999", appeal.id, ["pending"], "denied"), null);
    assert.equal(store.getAppeal(GUILD, appeal.id)?.status, "pending");
  });

  it("hides internal notes from the appellant's timeline", () => {
    const appeal = newAppeal();
    store.addEvent(appeal.id, "note", "staff", "Looks sincere");
    store.addEvent(appeal.id, "info_requested", "staff", "Which channel?");
    assert.deepEqual(store.listEvents(appeal.id, false).map((event) => event.kind), ["submitted", "info_requested"]);
    assert.equal(store.listEvents(appeal.id, true).length, 3);
    assert.equal(store.latestQuestion(appeal.id)?.body, "Which channel?");
  });

  it("counts every status regardless of the status filter", () => {
    const other = "200000000000000099";
    const a = newAppeal(1, other);
    newAppeal(2, other);
    store.transitionAppeal(GUILD, a.id, ["pending"], "denied");
    const result = store.listAppeals(GUILD, { status: "pending", type: null, userId: other, q: "", limit: 10, offset: 0 });
    assert.equal(result.total, 1);
    assert.equal(result.counts.pending, 1);
    assert.equal(result.counts.denied, 1);
  });

  it("finds appeals by case id", () => {
    const appeal = newAppeal(4242);
    assert.deepEqual(store.listCaseAppeals(GUILD, [4242]).map((row) => row.id), [appeal.id]);
  });
});

describe("staff notes", () => {
  const guild = { id: GUILD, client: {} } as unknown as import("discord.js").Guild;
  const config = {} as unknown as import("../../../config/schemas/appeals.js").AppealsConfig;

  it("saves a staff note to the timeline, hidden from the appellant", async () => {
    const { addAppealNote } = await import("./service.js");
    const appeal = newAppeal();
    const result = await addAppealNote(guild, config, appeal.id, "300000000000000009", "  Checked the logs, looks fine  ");
    assert.equal(result.ok, true);
    const staffView = store.listEvents(appeal.id, true).filter((e) => e.kind === "note");
    assert.equal(staffView.length, 1);
    assert.equal(staffView[0]!.body, "Checked the logs, looks fine");
    assert.equal(store.listEvents(appeal.id, false).some((e) => e.kind === "note"), false);
  });

  it("refuses notes from the appellant and empty notes", async () => {
    const { addAppealNote } = await import("./service.js");
    const appeal = newAppeal();
    const own = await addAppealNote(guild, config, appeal.id, USER, "about me");
    assert.equal(own.ok, false);
    assert.match(!own.ok ? own.error : "", /own appeal/);
    const empty = await addAppealNote(guild, config, appeal.id, "300000000000000009", "   ");
    assert.equal(empty.ok, false);
  });
});
