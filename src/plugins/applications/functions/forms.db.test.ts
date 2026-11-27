import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB, set before any getDb() call (see siteNotifications.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-forms-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../../../scripts/migrate.js");
runMigrations();

const { getDb } = await import("../../../db/client.js");
const store = await import("./store.js");
const { anonymousKey } = await import("./anonymous.js");
const { deleteUserPersonalData } = await import("../../../bridge/userProfiles.js");
const { exportUserPersonalData } = await import("../../../bridge/userDataExport.js");

function raw(): Database.Database {
  return (getDb() as unknown as { session: { client: Database.Database } }).session.client;
}

after(() => {
  try {
    raw().close();
  } catch {
    /* best effort */
  }
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    /* leftover temp dir is harmless */
  }
});

const GUILD = "800000000000000001";
const FORM = "0b6f7a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b";
const EVENT = "0b6f7a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5c";
const ALICE = "900000000000000001";
const BOB = "900000000000000002";

test("applications stored before Forms read back as pending applications", () => {
  // Exactly the columns the table had before migration 0164.
  raw()
    .prepare(
      "INSERT INTO applications (guild_id, opening_id, opening_name, user_id, status, answers_json, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
    )
    .run(GUILD, FORM, "Moderator", ALICE, JSON.stringify([{ questionId: "q", label: "Why?", answer: "I like helping" }]), Math.floor(Date.now() / 1000));
  const latest = store.latestApplication(GUILD, ALICE, FORM);
  assert.ok(latest);
  assert.equal(latest.formKind, "application");
  assert.equal(latest.anonymous, false);
  assert.equal(latest.rsvp, null);
  assert.equal(latest.status, "pending");
  assert.equal(latest.answers[0]!.answer, "I like helping");
  const decided = store.decideApplication(GUILD, latest.id, "accepted", BOB, null);
  assert.equal(decided?.status, "accepted");
  // A second decision never applies twice.
  assert.equal(store.decideApplication(GUILD, latest.id, "denied", BOB, null), null);
});

test("custom statuses only change from the status the reviewer saw", () => {
  const app = store.createApplication({ guildId: GUILD, openingId: FORM, openingName: "Moderator", userId: BOB, answers: [], formKind: "signup" });
  assert.equal(store.changeStatus(GUILD, app.id, "pending", "shortlist", ALICE, null)?.status, "shortlist");
  assert.equal(store.changeStatus(GUILD, app.id, "pending", "hired", ALICE, null), null);
  const counts = store.listApplications(GUILD, { status: null, openingId: FORM, userId: null, q: "", limit: 10, offset: 0 }).counts;
  assert.equal(counts.shortlist, 1);
});

test("RSVP counts, waitlist order and promotion bookkeeping", () => {
  const ids: number[] = [];
  for (let i = 0; i < 4; i++) {
    const userId = `90000000000000010${i}`;
    const rec = store.createApplication({
      guildId: GUILD,
      openingId: EVENT,
      openingName: "Game night",
      userId,
      answers: [],
      formKind: "rsvp",
      status: "submitted",
      rsvp: "going",
      waitlisted: i >= 2,
    });
    ids.push(rec.id);
  }
  assert.deepEqual(store.rsvpCounts(GUILD, EVENT), { going: 2, maybe: 0, not_going: 0, waitlisted: 2 });
  assert.deepEqual(store.waitlist(GUILD, EVENT).map((r) => r.id), [ids[2], ids[3]]);
  store.setRsvp(GUILD, ids[0]!, "not_going", false);
  store.setRsvp(GUILD, ids[2]!, "going", false);
  assert.deepEqual(store.rsvpCounts(GUILD, EVENT), { going: 2, maybe: 0, not_going: 1, waitlisted: 1 });
  assert.equal(store.goingResponses(GUILD, EVENT).length, 2);
  assert.ok(store.rsvpFormsWithAttendees().some((f) => f.openingId === EVENT));
  assert.equal(store.claimReminder(GUILD, EVENT, "2026-12-24T18:00:00Z"), true);
  assert.equal(store.claimReminder(GUILD, EVENT, "2026-12-24T18:00:00Z"), false);
});

test("response history counts both a member's normal and anonymous responses", () => {
  store.createApplication({ guildId: GUILD, openingId: FORM, openingName: "Survey", userId: anonymousKey(ALICE), answers: [], anonymous: true, formKind: "questionnaire", status: "submitted" });
  const history = store.responseHistory(GUILD, ALICE, FORM);
  assert.equal(history.mine, 2);
  assert.ok(history.total >= 3);
  assert.equal(history.latest?.anonymous, true);
});

test("data export and erase include every response a member sent, anonymous ones too", async () => {
  const before = store.responsesByMember(ALICE);
  assert.equal(before.length, 2);
  store.addApplicationEvent({ guildId: GUILD, applicationId: before[0]!.id, kind: "note", actorId: BOB, content: "Strong" });

  const exported = await exportUserPersonalData(ALICE);
  const section = (exported.sections as Record<string, { rows: unknown[] }>).form_responses;
  assert.equal(section?.rows.length, 2);

  const result = await deleteUserPersonalData(ALICE);
  assert.equal(result.deleted.form_responses, 2);
  assert.equal(result.deleted.form_response_notes, 1);
  assert.equal(store.responsesByMember(ALICE).length, 0);
  // Other members' responses are untouched.
  assert.ok(store.responsesByMember(BOB).length >= 1);
});
