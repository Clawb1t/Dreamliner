import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB, set before any getDb() call (same pattern as forms.db.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-memberhub-forms-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../scripts/migrate.js");
runMigrations();

const { getDb } = await import("../db/client.js");
const { configManager } = await import("../config/manager.js");
const { anonymousKey } = await import("../plugins/applications/functions/anonymous.js");
const { readForms } = await import("./webMemberHub.js");

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

const GUILD = "800000000000000002";
const MEMBER = "800000000000000010";
const OTHER = "800000000000000011";
const FORM = "1b6f7a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b";

const guildConfig = configManager.mergePreview(`
plugins:
  applications:
    enabled: true
    config:
      openings:
        - id: ${FORM}
          name: Moderator
          review_mode: custom
          statuses:
            - id: shortlisted
              label: Shortlisted
              tone: note
`);

function insert(userId: string, status: string, opts: { anonymous?: boolean; createdAt?: number; kind?: string; rsvp?: string } = {}): void {
  raw()
    .prepare(
      "INSERT INTO applications (guild_id, opening_id, opening_name, user_id, status, answers_json, created_at, form_kind, anonymous, rsvp, waitlisted) VALUES (?, ?, 'Moderator', ?, ?, '[]', ?, ?, ?, ?, 0)",
    )
    .run(GUILD, FORM, userId, status, opts.createdAt ?? 1_700_000_000, opts.kind ?? "application", opts.anonymous ? 1 : 0, opts.rsvp ?? null);
}

insert(MEMBER, "pending", { createdAt: 1_700_000_001 });
insert(MEMBER, "shortlisted", { createdAt: 1_700_000_002 });
insert(MEMBER, "accepted", { createdAt: 1_700_000_003 });
// Anonymous responses store a keyed hash, never the member's id: they must not appear.
insert(anonymousKey(MEMBER), "submitted", { anonymous: true, kind: "questionnaire", createdAt: 1_700_000_004 });
insert(OTHER, "pending", { createdAt: 1_700_000_005 });

test("Member 360 lists only the member's own, non-anonymous responses", async () => {
  const forms = await readForms(guildConfig, GUILD, MEMBER);
  assert.equal(forms.enabled, true);
  assert.equal(forms.total, 3);
  assert.deepEqual(
    forms.recent.map((r) => r.status),
    ["accepted", "shortlisted", "pending"],
    "newest first, without the anonymous or the other member's responses",
  );
});

test("custom statuses resolve to the form's label and tone, and only closing statuses count as done", async () => {
  const forms = await readForms(guildConfig, GUILD, MEMBER);
  const custom = forms.recent.find((r) => r.status === "shortlisted");
  assert.equal(custom?.statusLabel, "Shortlisted");
  assert.equal(custom?.tone, "note");
  assert.equal(forms.recent.find((r) => r.status === "accepted")?.statusLabel, "Accepted");
  // pending + shortlisted (doesn't close) are open; accepted is final.
  assert.equal(forms.open, 2);
});

test("a member with no responses gets an empty section", async () => {
  const forms = await readForms(guildConfig, GUILD, "800000000000000099");
  assert.equal(forms.total, 0);
  assert.equal(forms.open, 0);
  assert.deepEqual(forms.recent, []);
});
