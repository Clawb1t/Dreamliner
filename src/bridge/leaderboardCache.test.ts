import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

// Isolated scratch DB, set before any getDb() call.
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-leaderboard-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;
process.env.LOG_LEVEL = "error";

const { runMigrations } = await import("../scripts/migrate.js");
runMigrations();

const cache = await import("./leaderboardCache.js");
const boards = await import("./leaderboards.js");
const identities = await import("./identityStore.js");
const ghost = await import("../core/privacy/ghostMode.js");
const { getDb } = await import("../db/client.js");

const raw = () => (getDb() as unknown as { session: { client: Database.Database } }).session.client;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

function reset() {
  for (const table of ["leaderboard_cache", "user_identity_cache", "user_profiles"]) raw().exec(`DELETE FROM ${table}`);
  cache.resetBoardMemory();
  identities.resetIdentityMemory();
}

const id = (n: number) => (200000000000000000n + BigInt(n)).toString();

/** A stand-in for the discord.js client: users.fetch answers from `people`, counting calls. */
function fakeClient(people: Record<string, { username: string; globalName?: string | null; avatar?: string | null } | "unknown" | "error">) {
  const calls: string[] = [];
  const client = {
    users: {
      cache: new Map(),
      fetch: async (userId: string) => {
        calls.push(userId);
        const person = people[userId];
        if (!person || person === "unknown") throw Object.assign(new Error("Unknown User"), { code: 10013 });
        if (person === "error") throw new Error("socket hang up");
        return { id: userId, username: person.username, globalName: person.globalName ?? null, avatar: person.avatar ?? null, banner: null };
      },
    },
  };
  return { client: client as unknown as import("./identityStore.js").IdentityClient, calls };
}

const board = (ids: string[]) => ({ scope: "global", board: "voice", total: 100, ranked: ids.length, leaders: ids.map((userId, i) => ({ rank: i + 1, id: userId, name: `n${i}` })) });
const shownIds = (payload: unknown) => (payload as { leaders: Array<{ id: string; rank: number }> }).leaders.map((row) => [row.id, row.rank]);
const planOf = <T>(full: () => Promise<{ payload: T; complete: boolean }>, quick?: () => Promise<{ payload: T; complete: boolean }>) => async () => ({ full, quick: quick ?? full });

describe("rows only with a resolved identity", () => {
  beforeEach(reset);

  it("leaves out unknown and deleted accounts and fills the board from further down", async () => {
    const people = {
      [id(1)]: { username: "alpha" },
      [id(2)]: "unknown" as const,
      [id(3)]: { username: "deleted_user_1a2b3c" },
      [id(4)]: { username: "delta", globalName: "Delta" },
      [id(5)]: { username: "echo" },
      [id(6)]: { username: "fox" },
      [id(7)]: { username: "golf" },
    };
    const { client } = fakeClient(people);
    const candidates = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ userId: id(n), count: 100 - n }));
    const { picked, complete } = await boards.pickResolved(client, candidates, 4, { fetch: true }, new Set());
    assert.deepEqual(picked.map((row) => row.userId), [id(1), id(4), id(5), id(6)]);
    assert.equal(complete, true, "skips were definitive answers");
    // Ranks are renumbered over the shown rows only.
    const shown = cache.presentBoard({ leaders: picked.map((row, i) => ({ id: row.userId, rank: i + 7 })) }, 10, new Set());
    assert.deepEqual(shownIds(shown), [[id(1), 1], [id(4), 2], [id(5), 3], [id(6), 4]]);
    // Every shown identity has a name and an avatar URL (Discord's default when unset).
    for (const row of picked) {
      const identity = identities.shownIdentity(row.identity);
      assert.ok(identity?.name && identity.name !== row.userId);
      assert.match(identity!.avatar, /^https:\/\/cdn\.discordapp\.com\//);
    }
  });

  it("a lookup with no answer yet makes the build incomplete (row left out, never an ID)", async () => {
    const { client } = fakeClient({ [id(1)]: { username: "alpha" }, [id(2)]: "error", [id(3)]: { username: "charlie" } });
    const candidates = [1, 2, 3].map((n) => ({ userId: id(n), count: 10 - n }));
    const { picked, complete } = await boards.pickResolved(client, candidates, 3, { fetch: true }, new Set());
    assert.deepEqual(picked.map((row) => row.userId), [id(1), id(3)]);
    assert.equal(complete, false);
  });

  it("identities are stored: after a restart they come from the table without a Discord request", async () => {
    const { client, calls } = fakeClient({ [id(1)]: { username: "alpha", avatar: "abc" } });
    await identities.resolveIdentities(client, [id(1)], { fetch: true });
    assert.equal(calls.length, 1);
    identities.resetIdentityMemory();
    const again = await identities.resolveIdentities(client, [id(1)], { fetch: true });
    assert.equal(calls.length, 1, "no second fetch");
    assert.equal(again.found.get(id(1))?.username, "alpha");
  });
});

describe("leaderboard cache", () => {
  beforeEach(reset);

  it("an incomplete build never replaces a complete copy", async () => {
    const key = "leaderboard:test:complete";
    await cache.refreshBoard(key, planOf(async () => ({ payload: board([id(1), id(2)]), complete: true })));
    await cache.refreshBoard(key, planOf(async () => ({ payload: board([id(1)]), complete: false })));
    const served = await cache.serveBoard(key, planOf(async () => ({ payload: board([]), complete: false })), { freshMs: 60_000 });
    assert.deepEqual(shownIds(served!.payload), [[id(1), 1], [id(2), 2]]);
    // A failed build keeps it too.
    await cache.refreshBoard(key, async () => {
      throw new Error("database busy");
    });
    assert.deepEqual(shownIds(cache.getBoardEntry(key)!.payload), [[id(1), 1], [id(2), 2]]);
  });

  it("serves the stored copy after a restart, instantly, without rebuilding first", async () => {
    const key = "leaderboard:test:restart";
    await cache.refreshBoard(key, planOf(async () => ({ payload: board([id(1), id(2), id(3)]), complete: true })));
    cache.resetBoardMemory(); // restart
    assert.equal(cache.loadPersistedBoards(), 1);
    let builds = 0;
    const slow = planOf(async () => {
      builds++;
      await sleep(200);
      return { payload: board([id(9)]), complete: true };
    });
    const started = Date.now();
    const served = await cache.serveBoard(key, slow, { freshMs: 60_000 });
    assert.ok(Date.now() - started < 50, "didn't wait on a build");
    assert.deepEqual(shownIds(served!.payload), [[id(1), 1], [id(2), 2], [id(3), 3]]);
    assert.equal(builds, 0, "fresh enough: no rebuild");
  });

  it("concurrent requests share one build (single-flight)", async () => {
    let builds = 0;
    const build = planOf(async () => {
      builds++;
      await sleep(30);
      return { payload: board([id(1)]), complete: true };
    });
    const answers = await Promise.all(Array.from({ length: 10 }, () => cache.serveBoard("leaderboard:test:flight", build, { freshMs: 60_000 })));
    assert.equal(builds, 1);
    assert.ok(answers.every((answer) => answer && shownIds(answer.payload).length === 1));
  });

  it("a stale copy is served at once and rebuilt behind it", async () => {
    const key = "leaderboard:test:stale";
    await cache.refreshBoard(key, planOf(async () => ({ payload: board([id(1)]), complete: true })));
    cache.markBoardsStale("leaderboard:test:");
    const served = await cache.serveBoard(key, planOf(async () => ({ payload: board([id(2)]), complete: true })), { freshMs: 60_000 });
    assert.deepEqual(shownIds(served!.payload), [[id(1), 1]], "old copy right away");
    await sleep(20);
    assert.deepEqual(shownIds(cache.getBoardEntry(key)!.payload), [[id(2), 1]], "rebuilt in the background");
  });

  it("a board never built waits at most the cap, then answers from known identities", async () => {
    const key = "leaderboard:test:cold";
    const full = async () => {
      await sleep(300);
      return { payload: board([id(1), id(2)]), complete: true };
    };
    const quick = async () => ({ payload: board([id(1)]), complete: false });
    const started = Date.now();
    const served = await cache.serveBoard(key, planOf(full, quick), { freshMs: 60_000, coldCapMs: 60 });
    assert.ok(Date.now() - started < 250);
    assert.deepEqual(shownIds(served!.payload), [[id(1), 1]]);
    await sleep(350);
    assert.deepEqual(shownIds(cache.getBoardEntry(key)!.payload), [[id(1), 1], [id(2), 2]], "the full build replaced it");
  });
});

describe("Ghost Mode on every board, on every response", () => {
  beforeEach(reset);

  it("hidden from a global and a per-server board served from the stored copy; back once it expires", async () => {
    const ALICE = id(1);
    const rows = [ALICE, id(2), id(3), id(4)];
    await cache.refreshBoard(cache.leaderboardKeys.global("voice"), planOf(async () => ({ payload: board(rows), complete: true })));
    await cache.refreshBoard(cache.leaderboardKeys.guild("900", "messages"), planOf(async () => ({ payload: { scope: "server", ...board(rows) }, complete: true })));
    cache.resetBoardMemory(); // restart: both come back from the table
    cache.loadPersistedBoards();

    ghost.setGhostMode(ALICE, "24h");
    const noBuild = planOf(async (): Promise<{ payload: unknown; complete: boolean }> => {
      throw new Error("must not rebuild");
    });
    for (const key of [cache.leaderboardKeys.global("voice"), cache.leaderboardKeys.guild("900", "messages")]) {
      const entry = await cache.serveBoard(key, noBuild, { freshMs: 60 * 60_000 });
      // Limit 3: Alice removed, the rest renumbered, filled from the spare row.
      assert.deepEqual(shownIds(cache.presentBoard(entry!.payload, 3)), [[id(2), 1], [id(3), 2], [id(4), 3]], key);
    }

    // "Hide me from leaderboards" on its own does the same.
    ghost.setGhostMode(ALICE, null);
    ghost.setHideFromGlobalBoards(id(3), true);
    const entry = cache.getBoardEntry(cache.leaderboardKeys.guild("900", "messages"))!;
    assert.deepEqual(shownIds(cache.presentBoard(entry.payload, 3)), [[ALICE, 1], [id(2), 2], [id(4), 3]]);
    ghost.setHideFromGlobalBoards(id(3), false);

    // A timed Ghost Mode that has run out: listed again, at their real position.
    ghost.setGhostMode(ALICE, "1h", new Date(Date.now() - 2 * 3_600_000));
    assert.deepEqual(shownIds(cache.presentBoard(entry.payload, 3)), [[ALICE, 1], [id(2), 2], [id(3), 3]]);
  });

  it("builds skip Ghost Mode users too, so the stored board is full without them", async () => {
    const { client } = fakeClient({ [id(1)]: { username: "a" }, [id(2)]: { username: "b" }, [id(3)]: { username: "c" } });
    ghost.setGhostMode(id(1), "forever");
    const { picked } = await boards.pickResolved(client, [1, 2, 3].map((n) => ({ userId: id(n), count: 10 - n })), 2, { fetch: true });
    assert.deepEqual(picked.map((row) => row.userId), [id(2), id(3)]);
    ghost.setGhostMode(id(1), null);
  });
});
