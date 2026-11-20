/**
 * Giveaways: verifiable/idempotent draws, entry requirements, bonus entries, rerolls, the claim
 * window's auto-reroll and recurring scheduling, against a scratch database with every migration.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-giveaways-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;
{
  const db = new Database(join(scratchDir, "test.db"));
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../drizzle/migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, file), "utf8"));
  db.close();
}

const store = await import("./functions/store.js");
const { createSeed, poolHash, seededRandom, verifyDraw, weightedPick } = await import("./functions/fairness.js");
const { drawWinners, rerollWinners, expireUnclaimedWinners, claimWinner } = await import("./functions/draw.js");
const { checkEntryRequirements, computeEntryWeight } = await import("./functions/entries.js");
const { nextOccurrence } = await import("./functions/recurrence.js");
const { spawnNextOccurrence } = await import("./functions/lifecycle.js");
const { parseDurationText } = await import("./functions/create.js");
const { getDb } = await import("../../db/client.js");
const { zPersistEmbedConfig } = await import("../../config/schemas/persist.js");
const raw = () => (getDb() as unknown as { session: { client: Database.Database } }).session.client;

after(() => {
  try {
    raw().close();
  } catch {
    /* best effort */
  }
  rmSync(scratchDir, { recursive: true, force: true });
});

const GUILD = "123456789012345678";
const uid = (n: number) => String(100000000000000000n + BigInt(n));

async function makeGiveaway(overrides: Partial<Parameters<typeof store.createGiveaway>[0]> = {}) {
  const now = Date.now();
  return store.createGiveaway({
    guildId: GUILD,
    channelId: "223456789012345678",
    title: "Nitro",
    prize: "Nitro",
    status: "active",
    entryMethod: "button",
    reactionEmoji: "",
    buttonLabel: "Enter",
    buttonEmoji: "",
    buttonStyle: "primary",
    embedConfig: zPersistEmbedConfig.parse({}),
    winnerCount: 2,
    requireRoleIds: [],
    requireRoleMode: "any",
    blacklistRoleIds: [],
    bypassRoleIds: [],
    minAccountAgeDays: 0,
    minJoinAgeDays: 0,
    bonusRoleWeights: [],
    boosterBonusWeight: 0,
    entryCost: 0,
    winBonus: 0,
    dmWinner: false,
    dmNonWinners: false,
    claimWindowMinutes: 0,
    startsAt: new Date(now - 3_600_000),
    endsAt: new Date(now - 1000),
    createdBy: uid(999),
    ...overrides,
  });
}

async function enter(giveawayId: number, count: number, weight = 1) {
  for (let i = 1; i <= count; i++) await store.addEntry({ giveawayId, userId: uid(i), weight });
}

function member(opts: { roles?: string[]; accountAgeDays?: number; joinedDaysAgo?: number; booster?: boolean } = {}) {
  const now = Date.now();
  const roles = new Set(opts.roles ?? []);
  return {
    roles: { cache: { has: (id: string) => roles.has(id) } },
    user: { createdTimestamp: now - (opts.accountAgeDays ?? 365) * 86_400_000 },
    joinedTimestamp: now - (opts.joinedDaysAgo ?? 365) * 86_400_000,
    premiumSinceTimestamp: opts.booster ? now - 1000 : null,
  };
}

describe("fairness", () => {
  const pool = Array.from({ length: 20 }, (_, i) => ({ userId: uid(i), weight: (i % 3) + 1 }));

  it("gives the same winners for the same seed and pool, whatever order the pool is in", () => {
    const seed = createSeed();
    const a = verifyDraw(seed, pool, 5);
    const b = verifyDraw(seed, [...pool].reverse(), 5);
    assert.deepEqual(a, b);
    assert.equal(new Set(a).size, 5);
    assert.equal(poolHash(pool), poolHash([...pool].reverse()));
  });

  it("never picks excluded or zero-weight entrants, and stops when the pool runs out", () => {
    const small = [
      { userId: uid(1), weight: 1 },
      { userId: uid(2), weight: 0 },
      { userId: uid(3), weight: 2 },
    ];
    const picks = weightedPick(small, 5, new Set([uid(3)]), seededRandom("x"));
    assert.deepEqual(picks, [uid(1)]);
  });

  it("picks in proportion to weight", () => {
    const random = seededRandom("fairness");
    let heavy = 0;
    const trials = 4000;
    for (let i = 0; i < trials; i++) {
      const [pick] = weightedPick([{ userId: "a", weight: 1 }, { userId: "b", weight: 3 }], 1, new Set(), random);
      if (pick === "b") heavy++;
    }
    const share = heavy / trials;
    assert.ok(share > 0.71 && share < 0.79, `heavy share ${share}`);
  });
});

describe("draws", () => {
  it("draws once, even when called twice at the same time", async () => {
    const g = await makeGiveaway();
    await enter(g.id, 10);
    const [first, second] = await Promise.all([drawWinners(g), drawWinners(g)]);
    assert.deepEqual(first.winnerIds, second.winnerIds);
    assert.equal(first.winnerIds.length, 2);
    const draws = await store.listDraws(g.id);
    assert.equal(draws.length, 1);
    assert.equal((await store.listWinners(g.id)).length, 2);
    // The stored seed and pool reproduce the result.
    const pool = (await store.listEntries(g.id)).map((e) => ({ userId: e.userId, weight: e.weight }));
    assert.equal(draws[0]!.poolHash, poolHash(pool));
    assert.deepEqual(verifyDraw(draws[0]!.seed!, pool, 2), draws[0]!.pickedUserIds);
    const again = await drawWinners(g);
    assert.equal(again.alreadyDrawn, true);
  });

  it("only lets one caller claim a giveaway for ending", async () => {
    const g = await makeGiveaway();
    const [a, b] = await Promise.all([store.claimGiveawayForEnding(g.id), store.claimGiveawayForEnding(g.id)]);
    assert.equal([a, b].filter(Boolean).length, 1);
  });

  it("draws nobody from an empty pool", async () => {
    const g = await makeGiveaway();
    const result = await drawWinners(g);
    assert.deepEqual(result.winnerIds, []);
    assert.ok(await store.getInitialDraw(g.id));
  });
});

describe("rerolls", () => {
  it("replaces only the chosen winner, with someone who hasn't won", async () => {
    const g = await makeGiveaway({ winnerCount: 3 });
    await enter(g.id, 8);
    await drawWinners(g);
    const [target, ...rest] = await store.listCurrentWinners(g.id);
    const result = await rerollWinners(g, [target!.id], { actorId: uid(999) });
    assert.deepEqual(result.oldWinnerIds, [target!.userId]);
    assert.equal(result.newWinnerIds.length, 1);
    assert.ok(![target!.userId, ...rest.map((w) => w.userId)].includes(result.newWinnerIds[0]!));
    const current = await store.listCurrentWinners(g.id);
    assert.equal(current.length, 3);
    assert.ok(rest.every((w) => current.some((c) => c.id === w.id)));
    const draws = await store.listDraws(g.id);
    assert.deepEqual(draws.map((d) => d.kind), ["draw", "reroll"]);
  });

  it("rerolls every winner, and never twice for the same row", async () => {
    const g = await makeGiveaway({ winnerCount: 2 });
    await enter(g.id, 6);
    await drawWinners(g);
    const before = await store.listCurrentWinners(g.id);
    const all = await rerollWinners(g, null);
    assert.equal(all.oldWinnerIds.length, 2);
    assert.equal(all.newWinnerIds.length, 2);
    const stale = await rerollWinners(g, before.map((w) => w.id));
    assert.deepEqual(stale.oldWinnerIds, []);
  });
});

describe("claim window", () => {
  it("auto-rerolls winners who didn't claim in time, but not those who did", async () => {
    const g = await makeGiveaway({ winnerCount: 2, claimWindowMinutes: 10 });
    await enter(g.id, 6);
    await drawWinners(g);
    const [claimer, slow] = await store.listCurrentWinners(g.id);
    assert.deepEqual(await claimWinner(g, claimer!.userId), { ok: true });
    assert.deepEqual(await claimWinner(g, claimer!.userId), { ok: false, reason: "already_claimed" });

    assert.equal((await expireUnclaimedWinners(g)).oldWinnerIds.length, 0, "nothing is due yet");
    raw().prepare("UPDATE giveaway_winners SET selected_at = ? WHERE id = ?").run(Math.floor((Date.now() - 11 * 60_000) / 1000), slow!.id);
    assert.deepEqual(await claimWinner(g, slow!.userId), { ok: false, reason: "expired" });

    const result = await expireUnclaimedWinners(g);
    assert.deepEqual(result.oldWinnerIds, [slow!.userId]);
    assert.equal(result.newWinnerIds.length, 1);
    const winners = await store.listWinners(g.id);
    assert.equal(winners.find((w) => w.id === slow!.id)?.status, "expired_unclaimed");
    assert.equal(winners.find((w) => w.id === claimer!.id)?.status, "claimed");
    assert.equal((await store.listDraws(g.id)).at(-1)?.kind, "auto_reroll");
  });
});

describe("requirements and bonus entries", () => {
  const base = { requireRoleIds: [] as string[], requireRoleMode: "any" as const, blacklistRoleIds: [] as string[], bypassRoleIds: [] as string[], minAccountAgeDays: 0, minJoinAgeDays: 0 };
  const g = (over: Partial<typeof base>) => ({ ...base, ...over }) as unknown as Parameters<typeof checkEntryRequirements>[1];

  it("checks required roles in any and all mode", () => {
    assert.equal(checkEntryRequirements(member({ roles: ["r1"] }), g({ requireRoleIds: ["r1", "r2"] })).ok, true);
    assert.equal(checkEntryRequirements(member({ roles: ["r1"] }), g({ requireRoleIds: ["r1", "r2"], requireRoleMode: "all" } as never)).ok, false);
    assert.equal(checkEntryRequirements(member(), g({ requireRoleIds: ["r1"] })).ok, false);
  });

  it("blocks blocked roles and young accounts, and bypass roles skip everything", () => {
    assert.equal(checkEntryRequirements(member({ roles: ["bad"] }), g({ blacklistRoleIds: ["bad"] })).ok, false);
    assert.equal(checkEntryRequirements(member({ accountAgeDays: 2 }), g({ minAccountAgeDays: 7 })).ok, false);
    assert.equal(checkEntryRequirements(member({ joinedDaysAgo: 1 }), g({ minJoinAgeDays: 3 })).ok, false);
    assert.equal(checkEntryRequirements(member({ roles: ["vip", "bad"], accountAgeDays: 1 }), g({ bypassRoleIds: ["vip"], blacklistRoleIds: ["bad"], minAccountAgeDays: 30 })).ok, true);
  });

  it("gives the highest bonus role's entries plus the booster bonus", () => {
    const giveaway = { bonusRoleWeights: [{ roleId: "a", weight: 2 }, { roleId: "b", weight: 5 }], boosterBonusWeight: 1 };
    assert.equal(computeEntryWeight(member(), giveaway), 1);
    assert.equal(computeEntryWeight(member({ roles: ["a", "b"] }), giveaway), 5);
    assert.equal(computeEntryWeight(member({ roles: ["a"], booster: true }), giveaway), 3);
  });
});

describe("recurring giveaways", () => {
  it("schedules the next run one interval later, skipping runs that are already past", () => {
    const start = new Date("2026-01-01T18:00:00Z");
    const end = new Date("2026-01-01T20:00:00Z");
    const next = nextOccurrence(start, end, "daily", new Date("2026-01-01T20:00:00Z"))!;
    assert.equal(next.startsAt.toISOString(), "2026-01-02T18:00:00.000Z");
    assert.equal(next.endsAt.toISOString(), "2026-01-02T20:00:00.000Z");
    const late = nextOccurrence(start, end, "weekly", new Date("2026-01-20T00:00:00Z"))!;
    assert.equal(late.startsAt.toISOString(), "2026-01-22T18:00:00.000Z");
    assert.equal(nextOccurrence(start, end, "none"), null);
  });

  it("creates the next occurrence once", async () => {
    const g = await makeGiveaway({ recurrence: "weekly", status: "ended" });
    const [a, b] = await Promise.all([spawnNextOccurrence(g), spawnNextOccurrence(g)]);
    const created = [a, b].filter(Boolean);
    assert.equal(created.length, 1);
    assert.equal(created[0]!.status, "scheduled");
    assert.equal(created[0]!.recurrenceParentId, g.id);
    const parent = await store.getGiveaway(GUILD, g.id);
    assert.equal(parent?.recurrenceNextId, created[0]!.id);
    assert.equal(await spawnNextOccurrence(parent!), null);
    const children = (await store.listGiveaways(GUILD)).filter((x) => x.recurrenceParentId === g.id);
    assert.equal(children.length, 1);
  });
});

describe("durations", () => {
  it("reads simple and combined durations", () => {
    assert.equal(parseDurationText("30m"), 30 * 60_000);
    assert.equal(parseDurationText("1d12h"), 36 * 3_600_000);
    assert.equal(parseDurationText("45"), 45 * 60_000);
    assert.equal(parseDurationText("2 h"), 2 * 3_600_000);
    assert.equal(parseDurationText("soon"), null);
    assert.equal(parseDurationText("1x"), null);
  });
});
