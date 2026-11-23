/**
 * Leaderboard / profile load test against a scratch database full of fake data.
 *
 *   npx tsx src/scripts/benchLeaderboards.ts            # default scale (~20M rows)
 *   BENCH_SCALE=0.1 npx tsx src/scripts/benchLeaderboards.ts   # quick smoke run
 *   BENCH_REST_MS=250 ...                                # simulated Discord REST latency
 *
 * Nothing touches the real database: DATABASE_URL points at a temp file deleted at the end. Discord
 * is replaced by stubs whose REST calls just sleep, so the numbers show database cost plus the
 * number (and serialization) of Discord calls each page makes.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

const SCALE = Number(process.env.BENCH_SCALE ?? 1);
const REST_MS = Number(process.env.BENCH_REST_MS ?? 120);
// BENCH_KEEP=1 keeps the seeded database in a fixed folder and reuses it on the next run (seeding
// ~20M rows takes minutes), so only the first run pays for it.
const KEEP = process.env.BENCH_KEEP === "1";
const dir = KEEP ? join(tmpdir(), `dreamliner-bench-keep-${SCALE}`) : mkdtempSync(join(tmpdir(), "dreamliner-bench-"));
mkdirSync(dir, { recursive: true });
const dbFile = join(dir, "bench.db");
const alreadySeeded = KEEP && existsSync(join(dir, "seeded"));
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.LOG_LEVEL = "error";

const { runMigrations } = await import("./migrate.js");
runMigrations();
const { getDb } = await import("../db/client.js");
const sqlite = (getDb() as unknown as { session: { client: Database.Database } }).session.client;

const n = (value: number) => Math.max(1, Math.round(value * SCALE));
const snowflake = (i: number) => (100_000_000_000_000_000n + BigInt(i)).toString();
const guildId = (i: number) => (900_000_000_000_000_000n + BigInt(i)).toString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Seed ---------------------------------------------------------------------------------------

const GUILDS = n(4000);
/** [guild index, members with message rows] */
const BIG_GUILDS: Array<[number, number]> = [
  [0, n(800_000)], // the mega server
  [1, n(400_000)],
  ...Array.from({ length: 20 }, (_, i): [number, number] => [i + 2, n(80_000)]),
];
const SMALL_GUILD_MEMBERS = n(300);
const USERS = n(3_000_000);

function zipfCount(rank: number): number {
  return Math.floor(200_000 / Math.pow(rank + 1, 0.85)) + 1;
}

function seed(): void {
  if (alreadySeeded) {
    console.log("Reusing the seeded database from the last run.");
    return;
  }
  const t0 = Date.now();
  const insert = (sql: string, rows: Iterable<unknown[]>) => {
    const stmt = sqlite.prepare(sql);
    const tx = sqlite.transaction((batch: unknown[][]) => {
      for (const row of batch) stmt.run(...row);
    });
    let batch: unknown[][] = [];
    for (const row of rows) {
      batch.push(row as unknown[]);
      if (batch.length >= 50_000) {
        tx(batch);
        batch = [];
      }
    }
    if (batch.length) tx(batch);
  };

  // Global per-user message counts.
  insert(
    "insert into user_message_counts (user_id, count, last_message_at) values (?, ?, ?)",
    (function* () {
      for (let i = 0; i < USERS; i++) yield [snowflake(i), zipfCount(i), Math.floor(Date.now() / 1000) - (i % 86400)];
    })(),
  );

  // Per-guild per-user message counts.
  let totalGuildRows = 0;
  insert(
    "insert into guild_message_counts (guild_id, user_id, count) values (?, ?, ?)",
    (function* () {
      for (const [g, members] of BIG_GUILDS) {
        for (let u = 0; u < members; u++) {
          totalGuildRows++;
          yield [guildId(g), snowflake((u * 7) % USERS), zipfCount(u)];
        }
      }
      for (let g = 22; g < GUILDS; g++) {
        for (let u = 0; u < SMALL_GUILD_MEMBERS; u++) {
          totalGuildRows++;
          yield [guildId(g), snowflake((g * 131 + u * 17) % USERS), zipfCount(u)];
        }
      }
    })(),
  );

  // Per-guild per-user daily messages (profiles, analytics): 30 days for the big servers' heavy users.
  const DAYS = 30;
  const dayStr = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
  insert(
    "insert into guild_stats_user_daily (guild_id, user_id, stat_date, messages) values (?, ?, ?, ?)",
    (function* () {
      for (const [g, members] of BIG_GUILDS.slice(0, 8)) {
        const active = Math.min(members, n(60_000));
        for (let u = 0; u < active; u++) for (let d = 0; d < DAYS; d += 3) yield [guildId(g), snowflake((u * 7) % USERS), dayStr(d), 1 + ((u + d) % 40)];
      }
    })(),
  );

  // Per-guild daily totals and voice.
  insert(
    "insert into guild_stats_voice_daily (guild_id, stat_date, minutes, seconds, sessions, peak_concurrent) values (?, ?, ?, ?, ?, ?)",
    (function* () {
      for (let g = 0; g < GUILDS; g++) for (let d = 0; d < 90; d += 1) yield [guildId(g), dayStr(d), 100 + (d % 50), (100 + (d % 50)) * 60, 5 + (d % 9), 3 + (d % 7)];
    })(),
  );
  insert(
    "insert into guild_stats_user_voice_daily (guild_id, user_id, stat_date, minutes, seconds, sessions) values (?, ?, ?, ?, ?, ?)",
    (function* () {
      for (const [g, members] of BIG_GUILDS) {
        const active = Math.min(members, g === 0 ? n(250_000) : n(60_000));
        for (let u = 0; u < active; u++) {
          for (let d = 0; d < 6; d++) {
            const m = 1 + ((u * 3 + d * 11) % 240);
            yield [guildId(g), snowflake((u * 7) % USERS), dayStr(d * 9), m, m * 60, 1 + (u % 4)];
          }
        }
      }
    })(),
  );

  writeFileSync(join(dir, "seeded"), "ok");
  console.log(`Seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${USERS.toLocaleString()} users, ${totalGuildRows.toLocaleString()} guild-user rows, ${GUILDS.toLocaleString()} guilds.`);
}

// --- Fake Discord ---------------------------------------------------------------------------------

let restCalls = 0;

function fakeUser(id: string) {
  const user = {
    id,
    bot: false,
    username: `user_${id.slice(-6)}`,
    avatar: Number(id.slice(-1)) % 3 === 0 ? null : `hash${id.slice(-6)}`,
    banner: null,
    globalName: `User ${id.slice(-6)}`,
    displayName: `User ${id.slice(-6)}`,
    accentColor: null,
    displayAvatarURL: () => `https://cdn.example/avatars/${id}.png`,
    bannerURL: () => null,
    fetch: async () => {
      restCalls++;
      await sleep(REST_MS);
      return user;
    },
  };
  return user;
}

function fakeMember(id: string) {
  const user = fakeUser(id);
  return { id, user, displayName: user.displayName, roles: { cache: new Map() }, permissions: { has: () => false }, premiumSince: null };
}

const client = {
  users: {
    cache: new Map(),
    fetch: async (id: string) => {
      restCalls++;
      await sleep(REST_MS);
      return fakeUser(id);
    },
  },
  guilds: { cache: new Map<string, unknown>() },
  channels: { cache: new Map() },
  user: { id: "1" },
  application: null,
} as unknown as import("discord.js").Client;

function fakeGuild(index: number) {
  const id = guildId(index);
  const memberCache = new Map<string, unknown>();
  const guild = {
    id,
    name: `Server ${index}`,
    icon: null,
    banner: null,
    ownerId: snowflake(5),
    memberCount: index === 0 ? n(800_000) : 1000,
    client,
    members: {
      cache: memberCache,
      fetch: async (arg: string | { user: string | string[] }) => {
        restCalls++;
        await sleep(REST_MS);
        if (typeof arg !== "string" && Array.isArray(arg.user)) {
          // Gateway member request: one call for many users (half of them still members).
          const found = new Map<string, unknown>();
          for (const userId of arg.user) if (Number(userId.slice(-1)) % 2 === 0) found.set(userId, fakeMember(userId));
          return found;
        }
        const userId = typeof arg === "string" ? arg : (arg.user as string);
        const member = fakeMember(userId);
        memberCache.set(userId, member);
        return member;
      },
    },
    channels: { cache: new Map() },
    roles: { cache: new Map(), everyone: { id } },
    emojis: { cache: new Map() },
  };
  (client.guilds.cache as Map<string, unknown>).set(id, guild);
  return guild as unknown as import("discord.js").Guild;
}

// --- Timing ---------------------------------------------------------------------------------------

type Result = { name: string; coldMs: number; warmMs: number; rest: number; blockedMs: number; error?: string };
const results: Result[] = [];

/** Event-loop block time during `fn`: a 5ms ticker that records its worst lateness. */
async function measure(name: string, fn: () => Promise<unknown>): Promise<void> {
  const run = async () => {
    let worstLate = 0;
    let last = Date.now();
    const ticker = setInterval(() => {
      const now = Date.now();
      worstLate = Math.max(worstLate, now - last - 5);
      last = now;
    }, 5);
    const restBefore = restCalls;
    const start = process.hrtime.bigint();
    try {
      await fn();
      return { ms: Number(process.hrtime.bigint() - start) / 1e6, rest: restCalls - restBefore, blocked: worstLate };
    } catch (error) {
      return { ms: Number(process.hrtime.bigint() - start) / 1e6, rest: restCalls - restBefore, blocked: worstLate, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearInterval(ticker);
    }
  };
  const cold = await run();
  const warm = await run();
  results.push({ name, coldMs: cold.ms, warmMs: warm.ms, rest: cold.rest, blockedMs: cold.blocked, error: cold.error });
}

async function main() {
  seed();
  console.log("Analyzing tables...");
  sqlite.exec("analyze");

  const mega = fakeGuild(0);
  const big = fakeGuild(1);
  fakeGuild(5);
  const small = fakeGuild(GUILDS - 1);

  const webStats = await import("../bridge/webStats.js");
  const userStats = await import("../bridge/userStats.js");
  const publicProfile = await import("../bridge/userPublicProfile.js");
  const userActivity = await import("../bridge/userActivity.js");
  const probeUser = snowflake(3);

  // --- Leaderboards: build, serve from memory, serve after a restart ---------------------------
  const lb = await import("../bridge/leaderboardCache.js");
  const boards = await import("../bridge/leaderboards.js");
  const identities = await import("../bridge/identityStore.js");
  for (const board of lb.GLOBAL_BOARD_IDS) {
    await measure(`BUILD global ${board} (cold identities)`, () => lb.refreshBoard(lb.leaderboardKeys.global(board), boards.globalBoardBuilder(client, board)));
  }
  for (const [label, guild] of [["mega", mega], ["small", small]] as const) {
    for (const board of ["messages", "voice"] as const) {
      await measure(`BUILD ${label} ${board}`, () => lb.refreshBoard(lb.leaderboardKeys.guild(guild.id, board), boards.guildBoardBuilder(guild, board)));
    }
  }
  const serveMany = async (label: string, fn: () => Promise<unknown>, times = 1000) => {
    const start = process.hrtime.bigint();
    for (let i = 0; i < times; i++) await fn();
    const each = Number(process.hrtime.bigint() - start) / 1e6 / times;
    console.log(`  ${label}: ${each.toFixed(3)}ms per request (avg of ${times})`);
  };
  console.log("\nServing (memory):");
  await serveMany("global messages, 50 rows", () => lb.serveGlobalBoard(client, "messages", 50));
  await serveMany("mega server messages, 25 rows", () => lb.serveGuildBoard(mega, "messages", 25));
  await serveMany("global messages + JSON.stringify", async () => JSON.stringify(await lb.serveGlobalBoard(client, "messages", 50)));

  console.log("\nSimulated restart:");
  lb.resetBoardMemory();
  identities.resetIdentityMemory();
  const loadStart = process.hrtime.bigint();
  const loaded = lb.loadPersistedBoards();
  console.log(`  loaded ${loaded} stored boards in ${(Number(process.hrtime.bigint() - loadStart) / 1e6).toFixed(1)}ms`);
  const restBefore = restCalls;
  const firstStart = process.hrtime.bigint();
  const first = await lb.serveGlobalBoard(client, "messages", 50);
  console.log(`  first request after restart: ${(Number(process.hrtime.bigint() - firstStart) / 1e6).toFixed(2)}ms, ${restCalls - restBefore} REST, ${(first?.payload as { leaders: unknown[] }).leaders.length} rows`);
  lb.resetBoardMemory();
  const dbStart = process.hrtime.bigint();
  await lb.serveGuildBoard(mega, "voice", 25);
  console.log(`  board read back from the table on demand: ${(Number(process.hrtime.bigint() - dbStart) / 1e6).toFixed(2)}ms`);

  console.log("\nCold board, 20 concurrent visitors (never built):");
  const coldStart = Date.now();
  const coldRest = restCalls;
  const answers = await Promise.all(Array.from({ length: 20 }, () => lb.serveGuildBoard(big, "messages", 25)));
  console.log(`  answered in ${Date.now() - coldStart}ms, ${restCalls - coldRest} REST so far, rows: ${(answers[0]?.payload as { leaders?: unknown[] } | undefined)?.leaders?.length ?? "warming"}`);
  await lb.refreshBoard(lb.leaderboardKeys.guild(big.id, "messages"), boards.guildBoardBuilder(big, "messages"));
  console.log(`  full build landed after ${Date.now() - coldStart}ms, ${restCalls - coldRest} REST total`);

  if (process.env.BENCH_QUERIES === "1") {
    const g = await import("../plugins/stats/functions/globalQueries.js");
    const q = (name: string, fn: () => Promise<unknown>) => measure(`  query: ${name}`, fn);
    await q("getFilledGlobalDailyStats(30)", () => g.getFilledGlobalDailyStats(30));
    await q("getGlobalDailyTotals()", () => g.getGlobalDailyTotals());
    await q("getTopGlobalUsersByDaily(30,15)", () => g.getTopGlobalUsersByDaily(30, 15));
    await q("getTopGlobalChannelsByDaily(30,15)", () => g.getTopGlobalChannelsByDaily(30, 15));
    await q("getFilledGlobalDailyActiveUsers(30)", () => g.getFilledGlobalDailyActiveUsers(30));
    await q("getTrackedGlobalMessagesTotal(30)", () => g.getTrackedGlobalMessagesTotal(30));
    await q("getTrackedGlobalDailyMessagesTotal(30)", () => g.getTrackedGlobalDailyMessagesTotal(30));
    await q("getGlobalUserMessageRank(500)", () => g.getGlobalUserMessageRank(500));
    const d = await import("../plugins/stats/functions/daily.js");
    const v = await import("../plugins/stats/functions/voice.js");
    const r = await import("../plugins/stats/functions/retention.js");
    const gid = mega.id;
    await q("mega: getFilledDailyStats(30)", () => d.getFilledDailyStats(gid, 30));
    await q("mega: getDailyTotals", () => d.getDailyTotals(gid));
    await q("mega: getGuildHourlyHeatmap", () => d.getGuildHourlyHeatmap(gid));
    await q("mega: getFilledVoiceDailyStats(30)", () => v.getFilledVoiceDailyStats(gid, 30));
    await q("mega: getTopVoiceChannels(30,15)", () => v.getTopVoiceChannels(gid, 30, 15));
    await q("mega: getTopVoiceUsers(30,15)", () => v.getTopVoiceUsers(gid, 30, 15));
    await q("mega: getTopVoiceUsers(all,15)", () => v.getTopVoiceUsers(gid, 0, 15));
    await q("mega: getGuildTotalVoiceMinutes(all)", () => v.getGuildTotalVoiceMinutes(gid, 0));
    await q("mega: getActiveVoiceUserCount(all)", () => v.getActiveVoiceUserCount(gid, 0));
    await q("mega: getRetentionCohorts(7)", () => r.getRetentionCohorts(gid, 7));
    const qs = await import("../plugins/stats/functions/queries.js");
    await q("mega: getTopUsersByDaily(30,15)", () => qs.getTopUsersByDaily(gid, 30, 15));
    await q("mega: getTopChannelsByDaily(30,15)", () => qs.getTopChannelsByDaily(gid, 30, 15));
    await q("mega: getFilledDailyActiveUsers(30)", () => qs.getFilledDailyActiveUsers(gid, 30));
    await q("mega: getTopMessagers(15)", () => qs.getTopMessagers(gid, 15));
  }
  await measure("GLOBAL stats page (30 days)", () => webStats.buildWebGlobalStats(client, webStats.parseWebStatsQuery(new URL("http://x/?days=30"))));
  await measure("guild stats page: mega (30 days)", () => webStats.buildWebServerStats(mega, webStats.parseWebStatsQuery(new URL("http://x/?days=30"))));
  await measure("profile: personal stats", () => userStats.buildUserPersonalStats(client, probeUser));
  await measure("profile: public stats", () => publicProfile.buildPublicProfileStats(probeUser));
  await measure("profile: public activity", () => publicProfile.buildPublicProfileActivity(probeUser));
  await measure("profile: public servers", () => userActivity.listUserGuildSummaries(client, probeUser, 12));

  // --- Report ---
  const pad = (s: string, w: number) => s.padEnd(w);
  console.log(`\n${pad("Page / builder", 44)} ${pad("cold ms", 9)} ${pad("warm ms", 9)} ${pad("REST", 5)} ${pad("loop block", 11)}`);
  for (const r of results) {
    console.log(`${pad(r.name, 44)} ${pad(r.coldMs.toFixed(0), 9)} ${pad(r.warmMs.toFixed(0), 9)} ${pad(String(r.rest), 5)} ${pad(r.blockedMs.toFixed(0), 11)}${r.error ? `  ERROR: ${r.error}` : ""}`);
  }
  const failed = results.filter((r) => r.error);
  if (failed.length) process.exitCode = 1;
}

try {
  await main();
} finally {
  try {
    sqlite.close();
  } catch {
    /* best effort */
  }
  if (!KEEP) rmSync(dir, { recursive: true, force: true });
}
