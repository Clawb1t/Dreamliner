import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

// Isolated scratch DB, set before any getDb() call (see permissionRoles.test.ts).
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-privacy-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../../scripts/migrate.js");
runMigrations();

const policy = await import("./policy.js");
const ghost = await import("./ghostMode.js");
const cross = await import("./crossServer.js");
const boards = await import("./boardSnapshots.js");
const { PROTECTED_SURFACES, GLOBAL_ACTIVITY_TABLES, GLOBAL_TABLE_INTERNALS } = await import("./surfaces.js");
const { getDb } = await import("../../db/client.js");
const schema = await import("../../db/schema.js");
const { recordUserMessage } = await import("../../plugins/utility/functions/messageCounts.js");
const { sql, eq } = await import("drizzle-orm");

const raw = () => (getDb() as unknown as { session: { client: Database.Database } }).session.client;

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

const ALICE = "100000000000000001"; // the subject
const BOB = "100000000000000002"; // another viewer
const CAROL = "100000000000000003"; // allow-listed viewer
const DAVE = "100000000000000004"; // someone else on the boards

function reset() {
  const db = raw();
  for (const table of ["user_profiles", "ghost_mode_allowlist", "user_message_counts", "guild_message_counts", "guild_stats_user_daily", "user_hourly_activity", "economy_global_accounts", "global_board_snapshots"]) {
    db.exec(`DELETE FROM ${table}`);
  }
  boards.resetFrozenBoardMemo();
}

/** Pretends the row last changed on an earlier day, so the next change is "first of the day". */
function ageRow(table: string, where: string) {
  raw().exec(`UPDATE ${table} SET day_start_date = '2000-01-01' WHERE ${where}`);
}

describe("policy (pure)", () => {
  const now = new Date("2026-11-20T15:00:00Z");
  const on = (until: Date | null) => ({ enabled: true, until, hideLeaderboards: false });

  it("self always sees live, allow-listed viewers see live", () => {
    assert.equal(policy.resolveCrossServerAccess({ viewerId: ALICE, subjectId: ALICE, ghost: on(null), allowlisted: false, now }), "live");
    assert.equal(policy.resolveCrossServerAccess({ viewerId: CAROL, subjectId: ALICE, ghost: on(null), allowlisted: true, now }), "live");
  });

  it("everyone else gets the snapshot, or nothing under Ghost Mode", () => {
    assert.equal(policy.resolveCrossServerAccess({ viewerId: BOB, subjectId: ALICE, ghost: policy.GHOST_OFF, allowlisted: false, now }), "snapshot");
    assert.equal(policy.resolveCrossServerAccess({ viewerId: null, subjectId: ALICE, ghost: policy.GHOST_OFF, allowlisted: false, now }), "snapshot");
    assert.equal(policy.resolveCrossServerAccess({ viewerId: BOB, subjectId: ALICE, ghost: on(null), allowlisted: false, now }), "hidden");
    // An anonymous viewer can never be "allow-listed".
    assert.equal(policy.resolveCrossServerAccess({ viewerId: null, subjectId: ALICE, ghost: on(null), allowlisted: true, now }), "hidden");
  });

  it("a timed Ghost Mode expires by itself", () => {
    const until = policy.ghostUntilFromDuration("1h", now);
    assert.equal(until!.getTime() - now.getTime(), 3_600_000);
    assert.equal(policy.isGhostActive(on(until), now), true);
    assert.equal(policy.isGhostActive(on(until), new Date(until!.getTime() + 1)), false);
    assert.equal(policy.resolveCrossServerAccess({ viewerId: BOB, subjectId: ALICE, ghost: on(until), allowlisted: false, now: new Date(until!.getTime() + 1) }), "snapshot");
    assert.equal(policy.ghostUntilFromDuration("forever", now), null);
    assert.equal(policy.isGhostDuration("3d"), true);
    assert.equal(policy.isGhostDuration("2h"), false);
  });

  it("hide-from-boards works alone and is implied by Ghost Mode", () => {
    assert.equal(policy.isHiddenFromGlobalBoards({ enabled: false, until: null, hideLeaderboards: true }, now), true);
    assert.equal(policy.isHiddenFromGlobalBoards(on(null), now), true);
    assert.equal(policy.isHiddenFromGlobalBoards(policy.GHOST_OFF, now), false);
  });

  it("day-start values: today's saved value, else live", () => {
    assert.equal(policy.dayStartValue({ live: 10, dayStart: 7, dayStartDate: "2026-11-20" }, now), 7);
    assert.equal(policy.dayStartValue({ live: 10, dayStart: 7, dayStartDate: "2026-11-19" }, now), 10);
    assert.equal(policy.dayStartValue({ live: 10, dayStart: null, dayStartDate: null }, now), null);
  });

  it("leaderboard removal renumbers without gaps", () => {
    const rows = [{ userId: "a" }, { userId: "b" }, { userId: "c" }, { userId: "d" }];
    assert.deepEqual(policy.withoutHidden(rows, new Set(["b"]), 2), [
      { userId: "a", rank: 1 },
      { userId: "c", rank: 2 },
    ]);
    assert.equal(policy.visibleRank(5, 2), 4);
  });

  it("badges: live keeps progress, snapshot strips it, hidden drops stat badges", () => {
    const badges = [
      { id: "one", progress: null },
      { id: "talker", progress: { value: 9001 } },
    ];
    assert.deepEqual(policy.filterBadgesForAccess(badges, "live"), badges);
    assert.deepEqual(policy.filterBadgesForAccess(badges, "snapshot"), [
      { id: "one", progress: null },
      { id: "talker", progress: null },
    ]);
    assert.deepEqual(policy.filterBadgesForAccess(badges, "hidden"), [{ id: "one", progress: null }]);
  });
});

describe("day-start triggers (migration 0152)", () => {
  beforeEach(reset);

  it("a new row starts the day at zero, so today's messages never show to others", async () => {
    await recordUserMessage("g1", ALICE);
    await recordUserMessage("g1", ALICE);
    const row = getDb().select().from(schema.userMessageCounts).where(eq(schema.userMessageCounts.userId, ALICE)).get()!;
    assert.equal(row.count, 2);
    assert.equal(row.dayStartCount, 0);
    assert.equal(cross.snapshotGlobalMessages(ALICE).count, 0);
  });

  it("the first change of a new day saves the old value, later ones don't move it", async () => {
    raw().exec(`INSERT INTO user_message_counts (user_id, count, last_message_at) VALUES ('${ALICE}', 50, 1000)`);
    ageRow("user_message_counts", `user_id = '${ALICE}'`);
    await recordUserMessage("g1", ALICE); // upsert -> UPDATE trigger
    await recordUserMessage("g1", ALICE);
    const row = getDb().select().from(schema.userMessageCounts).where(eq(schema.userMessageCounts.userId, ALICE)).get()!;
    assert.equal(row.count, 52);
    assert.equal(row.dayStartCount, 50);
    assert.equal(row.dayStartLastAt?.getTime(), 1000 * 1000);
    assert.equal(cross.snapshotGlobalMessages(ALICE).count, 50);
  });

  it("hourly activity and global economy have the same day-start copy", () => {
    raw().exec(`INSERT INTO user_hourly_activity (user_id, hour_utc, count) VALUES ('${ALICE}', 3, 5)`);
    ageRow("user_hourly_activity", `user_id = '${ALICE}'`);
    raw().exec(`UPDATE user_hourly_activity SET count = count + 1 WHERE user_id = '${ALICE}'`);
    assert.equal(cross.hourlyActivityFor(BOB, ALICE).hours[3], 5);
    assert.equal(cross.hourlyActivityFor(ALICE, ALICE).hours[3], 6);

    raw().exec(`INSERT INTO economy_global_accounts (user_id, balance, daily_streak, created_at, updated_at) VALUES ('${ALICE}', 10, 4, 0, 0)`);
    ageRow("economy_global_accounts", `user_id = '${ALICE}'`);
    raw().exec(`UPDATE economy_global_accounts SET balance = 25, daily_streak = 5 WHERE user_id = '${ALICE}'`);
    assert.deepEqual(cross.globalEconomyFor(BOB, ALICE), { access: "snapshot", balance: 10, streak: 4 });
    assert.deepEqual(cross.globalEconomyFor(ALICE, ALICE), { access: "live", balance: 25, streak: 5 });
  });
});

describe("the gate: canViewCrossServerData", () => {
  beforeEach(reset);

  it("self / other / allow-listed / Ghost Mode / expired", () => {
    assert.equal(ghost.canViewCrossServerData(ALICE, ALICE), "live");
    assert.equal(ghost.canViewCrossServerData(BOB, ALICE), "snapshot");
    ghost.setGhostMode(ALICE, "forever");
    assert.equal(ghost.canViewCrossServerData(BOB, ALICE), "hidden");
    assert.equal(ghost.canViewCrossServerData(null, ALICE), "hidden");
    assert.equal(ghost.canViewCrossServerData(ALICE, ALICE), "live");
    ghost.addToGhostAllowlist(ALICE, CAROL);
    assert.equal(ghost.canViewCrossServerData(CAROL, ALICE), "live");
    assert.equal(ghost.canViewCrossServerData(BOB, ALICE), "hidden");
    ghost.removeFromGhostAllowlist(ALICE, CAROL);
    assert.equal(ghost.canViewCrossServerData(CAROL, ALICE), "hidden");

    // Timed: set an hour that already ended (a mocked clock), and it reads as off everywhere.
    ghost.setGhostMode(ALICE, "1h", new Date(Date.now() - 2 * 3_600_000));
    assert.equal(ghost.canViewCrossServerData(BOB, ALICE), "snapshot");
    assert.equal(ghost.getGhostState(ALICE).enabled, false, "expired state is tidied lazily");
    assert.equal(ghost.listHiddenFromGlobalBoards().has(ALICE), false);
  });

  it("allow list: no self, cap enforced, change hook fires", () => {
    const seen: string[] = [];
    const off = ghost.onGhostModeChange((id) => seen.push(id));
    assert.throws(() => ghost.addToGhostAllowlist(ALICE, ALICE), ghost.GhostAllowlistError);
    for (let i = 0; i < policy.GHOST_ALLOWLIST_MAX; i++) ghost.addToGhostAllowlist(ALICE, `2000000000000${String(i).padStart(5, "0")}`);
    assert.throws(() => ghost.addToGhostAllowlist(ALICE, CAROL), /up to 50/);
    off();
    assert.equal(seen.length, policy.GHOST_ALLOWLIST_MAX);
    assert.equal(seen[0], ALICE);
  });

  it("global stats: hidden, snapshot (numbers from 00:00 UTC), live", async () => {
    raw().exec(`INSERT INTO user_message_counts (user_id, count, last_message_at) VALUES ('${ALICE}', 100, ${Math.floor(Date.now() / 1000) - 3 * 86400}), ('${DAVE}', 500, 0), ('${BOB}', 300, 0)`);
    ageRow("user_message_counts", "1 = 1");
    await recordUserMessage("g1", ALICE);

    const other = cross.globalStatsFor(BOB, ALICE);
    assert.equal(other.access, "snapshot");
    if (other.access === "snapshot") {
      assert.equal(other.totalMessages, 100);
      assert.ok(other.lastActiveAt, "last seen stays visible without Ghost Mode");
      assert.equal(other.globalRank, 3);
      assert.ok(other.asOf);
    }
    const self = cross.globalStatsFor(ALICE, ALICE);
    assert.equal(self.access === "live" && self.totalMessages, 101);
    assert.ok(self.access === "live" && self.lastActiveAt);

    // DAVE hides from the boards: nobody counts him ahead of them any more.
    ghost.setHideFromGlobalBoards(DAVE, true);
    const after = cross.globalStatsFor(BOB, ALICE);
    assert.equal(after.access === "snapshot" && after.globalRank, 2);

    ghost.setGhostMode(ALICE, "8h");
    assert.deepEqual(cross.globalStatsFor(BOB, ALICE), { access: "hidden" });
    assert.equal(cross.globalMessageCountFor(BOB, ALICE), null);
    assert.equal(cross.globalMessageCountFor(ALICE, ALICE), 101);
  });

  it("server list and counts: snapshot drops servers first messaged today, hidden is empty", async () => {
    raw().exec(`INSERT INTO guild_message_counts (guild_id, user_id, count) VALUES ('old', '${ALICE}', 40), ('new', '${ALICE}', 3)`);
    const today = policy.utcDate();
    raw().exec(`INSERT INTO guild_stats_user_daily (guild_id, user_id, stat_date, messages) VALUES ('old', '${ALICE}', '${today}', 5), ('new', '${ALICE}', '${today}', 3)`);
    assert.deepEqual(cross.guildCountsFor(ALICE, "snapshot"), [{ guildId: "old", count: 35 }]);
    assert.equal(cross.guildCountsFor(ALICE, "live").length, 2);
    assert.deepEqual(cross.guildCountsFor(ALICE, "hidden"), []);
    const daily = cross.dailyActivityFor(BOB, ALICE, 7).daily;
    assert.equal(daily.length, 7);
    assert.notEqual(daily.at(-1)!.date, today, "others' graph ends yesterday");
    assert.equal(cross.dailyActivityFor(ALICE, ALICE, 7).daily.at(-1)!.messages, 8);
  });
});

describe("frozen global boards", () => {
  beforeEach(reset);

  it("built once per UTC day, rebuilt the next", async () => {
    let builds = 0;
    const build = async () => ({ n: ++builds });
    const day1 = new Date("2026-11-20T00:03:00Z");
    assert.deepEqual(await boards.frozenDaily("test", build, day1), { n: 1 });
    assert.deepEqual(await boards.frozenDaily("test", build, new Date("2026-11-20T23:59:00Z")), { n: 1 });
    boards.resetFrozenBoardMemo(); // a restart: still today's stored copy
    assert.deepEqual(await boards.frozenDaily("test", build, new Date("2026-11-20T12:00:00Z")), { n: 1 });
    // A new day: yesterday's copy is served at once while today's builds in the background...
    const day2 = new Date("2026-11-21T00:01:00Z");
    assert.deepEqual(await boards.frozenDaily("test", build, day2), { n: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    // ...and once built, today's copy is what everyone gets.
    assert.deepEqual(await boards.frozenDaily("test", build, day2), { n: 2 });
  });

  it("a failed or slow rebuild keeps serving the last copy instead of nothing", async () => {
    const day1 = new Date("2026-11-20T00:03:00Z");
    assert.deepEqual(await boards.frozenDaily("slow", async () => ({ v: "old" }), day1), { v: "old" });
    const day2 = new Date("2026-11-21T00:01:00Z");
    const failing = async (): Promise<{ v: string }> => {
      throw new Error("aggregation timed out");
    };
    assert.deepEqual(await boards.frozenDaily("slow", failing, day2), { v: "old" });
    await new Promise((resolve) => setImmediate(resolve));
    // Still the old copy after the failure, and the next request retries.
    assert.deepEqual(await boards.frozenDaily("slow", async () => ({ v: "new" }), day2), { v: "old" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await boards.frozenDaily("slow", async () => ({ v: "newer" }), day2), { v: "new" });
  });

  it("Ghost Mode users leave the board at once, numbers stay frozen", () => {
    const frozen = [
      { userId: DAVE, count: 500 },
      { userId: ALICE, count: 100 },
      { userId: BOB, count: 50 },
    ];
    ghost.setGhostMode(ALICE, "24h");
    const shown = policy.withoutHidden(frozen, ghost.listHiddenFromGlobalBoards());
    assert.deepEqual(
      shown.map((row) => [row.userId, row.rank, row.count]),
      [
        [DAVE, 1, 500],
        [BOB, 2, 50],
      ],
    );
    const access = ghost.crossServerAccessForMany([ALICE, BOB]);
    assert.equal(access.get(ALICE), "hidden");
    assert.equal(access.get(BOB), "snapshot");
  });
});

describe("protected surfaces", () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const read = (file: string) => readFileSync(join(srcRoot, file), "utf-8");
  const GATE = /canViewCrossServerData|crossServerAccessForMany|listHiddenFromGlobalBoards|globalStatsFor|globalMessageCountFor|globalEconomyFor|guildCountsFor|dailyActivityFor|hourlyActivityFor|snapshotGlobalMessages/;
  const TABLES = new RegExp(`\\b(${GLOBAL_ACTIVITY_TABLES.join("|")})\\b`);

  it("every gated surface goes through the cross-server gate", () => {
    for (const surface of PROTECTED_SURFACES.filter((s) => s.kind === "gated")) {
      assert.match(read(surface.file), GATE, `${surface.name} (${surface.file}) must use the gate in core/privacy`);
    }
  });

  it("same-server surfaces (locate, seen, Member 360, names) only read their own server", () => {
    for (const surface of PROTECTED_SURFACES.filter((s) => s.kind === "same-server")) {
      const source = read(surface.file);
      assert.doesNotMatch(source, TABLES, `${surface.name} must not read global activity tables`);
      assert.doesNotMatch(source, /guilds\.cache\.(values|forEach|filter|map)|for \(const \[, guild\] of/, `${surface.name} must not walk other servers`);
    }
    // /seen's queries are each narrowed to the asking server.
    const lastSeen = read("plugins/locate_user/functions/lastSeen.ts");
    const wheres = lastSeen.split(".where(").slice(1).map((part) => part.slice(0, 200));
    assert.ok(wheres.length >= 3, "expected the three /seen lookups");
    for (const where of wheres) assert.match(where, /guildId/);
  });

  it("no viewer-facing file reads the global activity tables directly", () => {
    const listed = new Set([...GLOBAL_TABLE_INTERNALS, ...PROTECTED_SURFACES.map((s) => s.file)]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
          const rel = relative(srcRoot, full).replaceAll("\\", "/");
          if (rel.startsWith("scripts/") || rel === "core/privacy/surfaces.ts") continue;
          if (TABLES.test(readFileSync(full, "utf-8")) && !listed.has(rel)) offenders.push(rel);
        }
      }
    };
    walk(srcRoot);
    assert.deepEqual(offenders, [], "read these through core/privacy/crossServer.ts, or list them in surfaces.ts");
  });

  it("the tracking path is untouched by Ghost Mode", async () => {
    reset();
    ghost.setGhostMode(ALICE, "forever");
    await recordUserMessage("g1", ALICE);
    const row = getDb().select().from(schema.userMessageCounts).where(eq(schema.userMessageCounts.userId, ALICE)).get();
    assert.equal(row?.count, 1, "messages still count while Ghost Mode is on");
    void sql;
  });
});

describe("last seen gate (Active now / Last seen)", () => {
  beforeEach(reset);

  it("shown to everyone, hidden by Ghost Mode except for self and the allow list", async () => {
    const { buildPublicProfileStats } = await import("../../bridge/userPublicProfile.js");
    const { lastSeenLabel } = await import("../../plugins/stats/functions/profileCard.js");
    await recordUserMessage("g1", ALICE); // active right now
    const lastSeen = async (viewer: string | null) => (await buildPublicProfileStats(ALICE, viewer)).lastActiveAt;

    // No Ghost Mode: everyone gets the real time, rendered as "Active now" / "Last seen 5m ago".
    for (const viewer of [ALICE, BOB, null]) assert.ok(await lastSeen(viewer), `visible to ${viewer ?? "anonymous"}`);
    assert.equal(lastSeenLabel(new Date((await lastSeen(BOB))!), new Date())?.text, "Active now");
    assert.equal(lastSeenLabel(new Date(Date.now() - 12 * 60_000), new Date())?.text, "Last seen 12m ago");

    ghost.setGhostMode(ALICE, "forever");
    ghost.addToGhostAllowlist(ALICE, CAROL);
    assert.equal(await lastSeen(BOB), null, "hidden from other people");
    assert.equal(await lastSeen(null), null, "hidden from anonymous visitors and cached views");
    assert.ok(await lastSeen(CAROL), "allow-listed viewers still see it");
    assert.ok(await lastSeen(ALICE), "you always see your own");

    // Timer ran out: visible again.
    ghost.setGhostMode(ALICE, "1h", new Date(Date.now() - 2 * 3_600_000));
    assert.ok(await lastSeen(BOB));
  });
});
