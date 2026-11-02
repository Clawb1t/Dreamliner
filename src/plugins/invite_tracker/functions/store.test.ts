import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB, set before any getDb() call (see permissionRoles.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-invites-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../../../scripts/migrate.js");
runMigrations();

const store = await import("./store.js");
const { inviteTemplateVars } = await import("./messages.js");
const { getDb } = await import("../../../db/client.js");
const { inviteBonus, inviteDailyStats, inviteJoins, inviteResets } = await import("../../../db/schema.js");

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
const A = "200000000000000002";
const B = "300000000000000003";
const DAY = 86_400_000;
let memberSeq = 0;

function join_(inviterId: string | null, extra: Partial<Parameters<typeof store.insertJoin>[0]> = {}) {
  memberSeq += 1;
  return store.insertJoin({
    guildId: GUILD,
    memberId: `9${String(memberSeq).padStart(17, "0")}`,
    inviterId,
    code: "abc",
    source: inviterId ? "invite" : "vanity",
    trackedLinkId: null,
    joinedAt: new Date(Date.now() - 1000),
    status: "valid",
    fakeReason: null,
    counted: true,
    accountCreatedAt: new Date(Date.now() - 400 * DAY),
    ...extra,
  });
}

beforeEach(() => {
  const db = getDb();
  db.delete(inviteJoins).run();
  db.delete(inviteBonus).run();
  db.delete(inviteResets).run();
  db.delete(inviteDailyStats).run();
  store.invalidateCounts(GUILD);
});

describe("invite counts", () => {
  it("sums regular, left and fake with CASE, skipping pending and uncounted joins", () => {
    join_(A);
    join_(A);
    const left = join_(A);
    store.updateJoin(GUILD, left.id, { leftAt: new Date() });
    join_(A, { status: "fake", fakeReason: "account_age" });
    join_(A, { status: "pending" });
    join_(A, { counted: false });
    join_(null);
    assert.deepEqual(store.getCounts(GUILD, A), { regular: 4, left: 1, fake: 1, bonus: 0, total: 2 });
  });

  it("merges bonuses, including members with no joins", () => {
    join_(A);
    store.addBonus(GUILD, A, 5);
    store.addBonus(GUILD, A, -2);
    store.addBonus(GUILD, B, 3);
    assert.equal(store.getCounts(GUILD, A).total, 4);
    assert.deepEqual(store.getCounts(GUILD, B), { regular: 0, left: 0, fake: 0, bonus: 3, total: 3 });
    assert.deepEqual(
      store.getGuildCounts(GUILD).rows.map((row) => row.userId),
      [A, B],
    );
  });

  it("a member reset ignores their earlier joins and clears their bonus", () => {
    join_(A, { joinedAt: new Date(Date.now() - 10_000) });
    join_(B, { joinedAt: new Date(Date.now() - 10_000) });
    store.addBonus(GUILD, A, 4);
    store.resetMemberCounts(GUILD, A, new Date(Date.now() - 5000));
    join_(A);
    assert.equal(store.getCounts(GUILD, A).total, 1);
    assert.equal(store.getCounts(GUILD, A).bonus, 0);
    assert.equal(store.getCounts(GUILD, B).total, 1);
  });

  it("a guild reset applies to everyone, and the later of two cutoffs wins", () => {
    join_(A, { joinedAt: new Date(Date.now() - 20_000) });
    join_(A, { joinedAt: new Date(Date.now() - 8000) });
    join_(B, { joinedAt: new Date(Date.now() - 8000) });
    store.resetMemberCounts(GUILD, A, new Date(Date.now() - 5000));
    store.resetGuildCounts(GUILD, new Date(Date.now() - 10_000));
    // A's own cutoff (5s ago) is later than the guild's (10s ago), so both of A's joins are out.
    assert.equal(store.getCounts(GUILD, A).total, 0);
    assert.equal(store.getCounts(GUILD, B).total, 1);
    // History is kept.
    assert.equal(store.listInvitedBy(GUILD, A).total, 2);
  });

  it("the total is regular − left − fake + bonus", () => {
    assert.equal(store.inviteTotal({ regular: 10, left: 2, fake: 3, bonus: 1 }), 6);
  });
});

describe("retention", () => {
  it("folds old joins into daily stats and deletes them", () => {
    const old = new Date(Date.UTC(2025, 0, 15, 12));
    join_(A, { joinedAt: old });
    join_(A, { joinedAt: old, status: "fake", fakeReason: "self" });
    const leaver = join_(A, { joinedAt: old });
    store.updateJoin(GUILD, leaver.id, { leftAt: new Date(old.getTime() + 1000) });
    join_(A);
    const folded = store.foldOldJoins(GUILD, new Date(Date.UTC(2025, 6, 1)));
    assert.equal(folded, 3);
    const rows = getDb().select().from(inviteDailyStats).all();
    assert.deepEqual(rows, [
      { guildId: GUILD, day: "2025-01-15", source: "invite", trackedLinkId: 0, joins: 3, leaves: 1, fakes: 1 },
    ]);
    assert.equal(getDb().select().from(inviteJoins).all().length, 1);
    // Folding again adds nothing.
    assert.equal(store.foldOldJoins(GUILD, new Date(Date.UTC(2025, 6, 1))), 0);
  });
});

describe("personal data", () => {
  it("deletes a member's own joins and blanks them as an inviter", () => {
    join_(A, { memberId: B });
    join_(B);
    store.addBonus(GUILD, B, 2);
    assert.equal(store.countUserInviteData(B), 2);
    store.deleteUserInviteData(B);
    const rows = getDb().select().from(inviteJoins).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.inviterId, null);
    assert.equal(store.countUserInviteData(B), 0);
  });
});

describe("template vars", () => {
  it("neutralizes mentions in names", () => {
    const vars = inviteTemplateVars({
      inviterId: A,
      inviterName: "@everyone <@&123>",
      counts: { regular: 3, left: 1, fake: 0, bonus: 0, total: 2 },
      code: "abc",
      linkName: "<@456>",
      source: "invite",
      joinCount: 1,
      accountCreatedAt: Date.now() - 3 * DAY,
    });
    assert.ok(!vars.inviter_name!.includes("@everyone"));
    assert.ok(!vars.inviter_name!.includes("<@&"));
    assert.ok(!vars.invite_link_name!.includes("<@"));
    assert.ok(!vars.join_source!.includes("@everyone"));
    assert.equal(vars.invites, "2");
    assert.equal(vars.account_age, "3 days");
  });
});
