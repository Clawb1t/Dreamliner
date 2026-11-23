/**
 * Public leaderboards: build in the background, persist, serve the last complete copy instantly.
 *
 * Pipeline
 * - Build: a board is ranked from the database with headroom (several times the rows shown), then
 *   rows are resolved to real identities (identityStore.ts) until the board is full. Rows that can't
 *   be resolved (deleted/unknown accounts) are left out and the rest renumbered, so a board never
 *   shows a bare user ID. See leaderboards.ts.
 * - Complete or nothing: a build only replaces the stored copy once every row it shows has a
 *   resolved identity and every row it skipped was skipped on a definitive answer. A build that ran
 *   out of answers, or failed, keeps the previous copy in place.
 * - Persist: complete builds are written to `leaderboard_cache` and loaded back on boot, so a
 *   restart serves the last good boards straight away instead of rebuilding cold.
 * - Serve: requests are answered from memory (or the stored copy) without ever waiting on Discord;
 *   a copy older than its freshness window is rebuilt in the background (single-flight per board).
 *   Only a board that has never been built waits, at most COLD_CAP_MS, and then gets whatever was
 *   already resolvable (unresolved rows left out) while the full build carries on.
 * - Refresh: the warmer rebuilds the global boards every couple of minutes, and the boards of
 *   recently visited servers (an LRU of visits) on a slower cycle.
 * - Ghost Mode: anyone with Ghost Mode on, or hidden from leaderboards, is removed from EVERY board
 *   on EVERY response (presentBoard), cached and persisted copies included, so turning it on takes
 *   effect at once without waiting for a rebuild. Boards are stored with spare rows so the removal
 *   still leaves a full board.
 */
import type { Client, Guild } from "discord.js";
import { eq, lt } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { leaderboardCache } from "../db/schema.js";
import { getLogger } from "../core/logger.js";
import { listHiddenFromLeaderboards } from "../core/privacy/ghostMode.js";

const log = getLogger("leaderboards");

// --- Types ---------------------------------------------------------------------------------------

export type BuiltBoard<T> = { payload: T; complete: boolean };
/**
 * A ranked board ready to be resolved. `full` resolves every identity it needs (fetching from
 * Discord through the shared queue); `quick` uses only identities already known, for the one-off
 * cold-start answer. Both run off the same database ranking.
 */
export type BoardPlan<T> = { full(): Promise<BuiltBoard<T>>; quick(): Promise<BuiltBoard<T>> };
export type BoardBuilder<T> = () => Promise<BoardPlan<T>>;

export type BoardEntry = {
  payload: unknown;
  builtAt: number;
  /** False only for a cold-start copy built from already-known identities (never persisted). */
  complete: boolean;
  /** Due for a rebuild regardless of age (a profile or Ghost Mode change); still served meanwhile. */
  stale?: boolean;
};

type Job = { plan: Promise<BoardPlan<unknown>>; done: Promise<BoardEntry | null> };

// --- Settings ------------------------------------------------------------------------------------

export const GLOBAL_FRESH_MS = 90_000;
export const GUILD_FRESH_MS = 60_000;
/** Longest a request waits for a board that has never been built. */
export const COLD_CAP_MS = 3000;
/** A failed or incomplete build is retried no sooner than this. */
const RETRY_AFTER_MS = 10_000;
/** Boards kept in memory; the rest are read back from the table when asked for. */
const MAX_MEMORY_BOARDS = 1500;
/** Stored boards nobody has rebuilt for this long are deleted on boot. */
const PERSIST_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/** Rows the website shows per board, and the most any request can ask for. */
export const BOARD_ROWS = 50;
/** Spare rows stored past BOARD_ROWS, so serve-time Ghost Mode removals still leave a full board. */
export const BOARD_SPARE_ROWS = 15;

export type GlobalBoardId = "messages" | "voice" | "streaks" | "fleet";
export type GuildBoardId = "messages" | "voice" | "streaks" | "fleet";
export const GLOBAL_BOARD_IDS: readonly GlobalBoardId[] = ["messages", "voice", "streaks", "fleet"];
export const GUILD_BOARD_IDS: readonly GuildBoardId[] = ["messages", "voice", "streaks", "fleet"];

export const leaderboardKeys = {
  global: (board: GlobalBoardId) => `leaderboard:global:${board}`,
  guild: (guildId: string, board: GuildBoardId) => `leaderboard:guild:${guildId}:${board}`,
};

// --- Store ---------------------------------------------------------------------------------------

const memory = new Map<string, BoardEntry>();
const jobs = new Map<string, Job>();
const lastAttempt = new Map<string, number>();

function remember(key: string, entry: BoardEntry): void {
  memory.delete(key);
  memory.set(key, entry);
  while (memory.size > MAX_MEMORY_BOARDS) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

function persist(key: string, entry: BoardEntry): void {
  try {
    const payload = JSON.stringify(entry.payload);
    getDb()
      .insert(leaderboardCache)
      .values({ key, payload, builtAt: entry.builtAt })
      .onConflictDoUpdate({ target: leaderboardCache.key, set: { payload, builtAt: entry.builtAt } })
      .run();
  } catch (error) {
    log.warn(`storing ${key} failed: ${error instanceof Error ? error.message : error}`);
  }
}

/** The current copy of `key`: memory first, then the stored copy. */
export function getBoardEntry(key: string): BoardEntry | undefined {
  const hit = memory.get(key);
  if (hit) return hit;
  try {
    const row = getDb().select().from(leaderboardCache).where(eq(leaderboardCache.key, key)).get();
    if (!row) return undefined;
    const entry: BoardEntry = { payload: JSON.parse(row.payload), builtAt: row.builtAt, complete: true };
    remember(key, entry);
    return entry;
  } catch {
    return undefined;
  }
}

/** Takes a finished build: a complete one replaces the copy (and is stored); an incomplete one is
 *  only kept, in memory, when there is no copy at all. */
function accept(key: string, built: BuiltBoard<unknown>, startedAt: number): BoardEntry | null {
  const previous = memory.get(key) ?? getBoardEntry(key);
  const tookMs = Date.now() - startedAt;
  if (built.complete) {
    const entry: BoardEntry = { payload: built.payload, builtAt: Date.now(), complete: true };
    remember(key, entry);
    persist(key, entry);
    log.debug(`built ${key} in ${tookMs}ms`);
    return entry;
  }
  if (previous?.complete) {
    log.debug(`build of ${key} incomplete after ${tookMs}ms; still serving the copy from ${new Date(previous.builtAt).toISOString()}`);
    return previous;
  }
  const entry: BoardEntry = { payload: built.payload, builtAt: Date.now(), complete: false };
  remember(key, entry);
  log.debug(`built ${key} without every identity in ${tookMs}ms (no complete copy yet)`);
  return entry;
}

function startJob(key: string, build: BoardBuilder<unknown>): Job {
  const running = jobs.get(key);
  if (running) return running;
  const startedAt = Date.now();
  lastAttempt.set(key, startedAt);
  const plan = build();
  const done = plan
    .then((p) => p.full())
    .then((built) => accept(key, built, startedAt))
    .catch((error: unknown) => {
      log.warn(`building ${key} failed after ${Date.now() - startedAt}ms; keeping the previous copy: ${error instanceof Error ? error.message : error}`);
      return memory.get(key) ?? null;
    })
    .finally(() => jobs.delete(key));
  plan.catch(() => undefined);
  const job: Job = { plan, done };
  jobs.set(key, job);
  return job;
}

/** Rebuilds `key` now (joining a build already running). Resolves to the copy in place afterwards. */
export function refreshBoard<T>(key: string, build: BoardBuilder<T>): Promise<BoardEntry | null> {
  return startJob(key, build as BoardBuilder<unknown>).done;
}

function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  if (ms <= 0) return Promise.resolve(undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    }),
  ]).finally(() => timer && clearTimeout(timer));
}

/**
 * The copy of a board to answer a request with. Never waits when any copy exists (a stale one is
 * rebuilt behind it). A board never built before waits up to `coldCapMs` for its first build, then
 * settles for one made from already-known identities. Null only when even that isn't ready.
 */
export async function serveBoard<T>(
  key: string,
  build: BoardBuilder<T>,
  options: { freshMs: number; coldCapMs?: number },
): Promise<BoardEntry | null> {
  const now = Date.now();
  const entry = getBoardEntry(key);
  if (entry) {
    const stale = !entry.complete || entry.stale || now - entry.builtAt > options.freshMs;
    if (stale && !jobs.has(key) && now - (lastAttempt.get(key) ?? 0) > RETRY_AFTER_MS) {
      void refreshBoard(key, build);
    }
    return entry;
  }
  const cap = options.coldCapMs ?? COLD_CAP_MS;
  const startedAt = Date.now();
  const job = startJob(key, build as BoardBuilder<unknown>);
  const first = await within(job.done, cap);
  if (first) return first;
  // Out of time: answer with what's already known, and let the full build finish behind it.
  const quick = await within(
    job.plan.then((p) => p.quick()),
    Math.max(500, cap - (Date.now() - startedAt)),
  ).catch(() => undefined);
  if (!quick) return memory.get(key) ?? null;
  const existing = memory.get(key);
  if (existing) return existing; // the full build landed meanwhile
  const provisional: BoardEntry = { payload: quick.payload, builtAt: Date.now(), complete: quick.complete };
  if (quick.complete) {
    remember(key, provisional);
    persist(key, provisional);
  } else {
    remember(key, provisional);
  }
  return provisional;
}

/** Marks every copy whose key starts with `prefix` as due for a rebuild (still served meanwhile). */
export function markBoardsStale(prefix = "leaderboard:"): void {
  for (const [key, entry] of memory) {
    if (key.startsWith(prefix)) entry.stale = true;
  }
  lastAttempt.clear();
}

/** Loads every stored board into memory (boot). Deletes boards nobody has rebuilt in a month. */
export function loadPersistedBoards(): number {
  const db = getDb();
  try {
    db.delete(leaderboardCache).where(lt(leaderboardCache.builtAt, Date.now() - PERSIST_MAX_AGE_MS)).run();
    const rows = db.select().from(leaderboardCache).all();
    rows.sort((a, b) => a.builtAt - b.builtAt);
    let loaded = 0;
    for (const row of rows) {
      try {
        remember(row.key, { payload: JSON.parse(row.payload), builtAt: row.builtAt, complete: true });
        loaded++;
        const guildMatch = /^leaderboard:guild:(\d+):/.exec(row.key);
        if (guildMatch) noteGuildBoardVisit(guildMatch[1]!, row.builtAt);
      } catch {
        // unreadable row: rebuilt on demand
      }
    }
    return loaded;
  } catch (error) {
    log.warn(`loading stored leaderboards failed: ${error instanceof Error ? error.message : error}`);
    return 0;
  }
}

/** Tests only: forgets memory and jobs (the table is kept, like a restart). */
export function resetBoardMemory(): void {
  memory.clear();
  jobs.clear();
  lastAttempt.clear();
  visits.clear();
}

// --- Serve-time presentation ---------------------------------------------------------------------

type Leader = { id?: string; rank?: number };

/**
 * A board as one response shows it: everyone in Ghost Mode (or hidden from leaderboards) taken
 * out, the rest renumbered 1..n, cut to `limit`. Runs on every response, cached copies included.
 */
export function presentBoard<T>(payload: T, limit: number, hidden: ReadonlySet<string> = listHiddenFromLeaderboards()): T {
  const leaders = (payload as { leaders?: Leader[] }).leaders;
  if (!Array.isArray(leaders)) return payload;
  const out: Leader[] = [];
  for (const row of leaders) {
    if (row.id && hidden.has(row.id)) continue;
    out.push({ ...row, rank: out.length + 1 });
    if (out.length >= limit) break;
  }
  return { ...payload, leaders: out };
}

export function clampBoardLimit(raw: unknown, fallback = 25): number {
  const n = Number(raw);
  return Math.min(BOARD_ROWS, Math.max(1, Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback));
}

// --- Boards --------------------------------------------------------------------------------------

/** One global board, ready to send (Ghost Mode applied, cut to `limit`). Null = still warming. */
export async function serveGlobalBoard(client: Client, board: GlobalBoardId, limit: number): Promise<{ payload: unknown; builtAt: number } | null> {
  const { globalBoardBuilder } = await import("./leaderboards.js");
  const entry = await serveBoard(leaderboardKeys.global(board), globalBoardBuilder(client, board), { freshMs: GLOBAL_FRESH_MS });
  return entry ? { payload: presentBoard(entry.payload, limit), builtAt: entry.builtAt } : null;
}

/** One server board, ready to send (Ghost Mode applied, cut to `limit`). Null = still warming. */
export async function serveGuildBoard(guild: Guild, board: GuildBoardId, limit: number): Promise<{ payload: unknown; builtAt: number } | null> {
  noteGuildBoardVisit(guild.id);
  const { guildBoardBuilder } = await import("./leaderboards.js");
  const entry = await serveBoard(leaderboardKeys.guild(guild.id, board), guildBoardBuilder(guild, board), { freshMs: GUILD_FRESH_MS });
  return entry ? { payload: presentBoard(entry.payload, limit), builtAt: entry.builtAt } : null;
}

// --- Warmer --------------------------------------------------------------------------------------

/** Recently visited servers (most recent last), kept warm by the warmer. */
const visits = new Map<string, number>();
const MAX_TRACKED_VISITS = 500;
export const WARM_GUILDS = 25;
const WARM_VISIT_WINDOW_MS = 24 * 60 * 60_000;
export const WARM_INTERVAL_MS = 60_000;
/** Server boards are re-warmed once they're this old (visitors in between still trigger a refresh). */
const GUILD_WARM_AGE_MS = 3 * 60_000;

export function noteGuildBoardVisit(guildId: string, at = Date.now()): void {
  const previous = visits.get(guildId) ?? 0;
  visits.delete(guildId);
  visits.set(guildId, Math.max(previous, at));
  while (visits.size > MAX_TRACKED_VISITS) {
    const oldest = visits.keys().next().value;
    if (oldest === undefined) break;
    visits.delete(oldest);
  }
}

/** The servers to keep warm: most recently visited first, within the last day. */
export function guildsToWarm(now = Date.now(), max = WARM_GUILDS): string[] {
  return [...visits.entries()]
    .filter(([, at]) => now - at <= WARM_VISIT_WINDOW_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([guildId]) => guildId);
}

const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * One warmer pass: every global board older than its freshness window, then each recently visited
 * server's boards older than GUILD_WARM_AGE_MS. One build at a time; identities come from the
 * durable cache, so a pass normally makes few or no Discord requests.
 */
export async function warmLeaderboards(client: Client): Promise<void> {
  const { globalBoardBuilder, guildBoardBuilder } = await import("./leaderboards.js");
  const started = Date.now();
  let built = 0;
  for (const board of GLOBAL_BOARD_IDS) {
    const key = leaderboardKeys.global(board);
    const entry = getBoardEntry(key);
    if (entry?.complete && !entry.stale && Date.now() - entry.builtAt < GLOBAL_FRESH_MS) continue;
    await yieldLoop();
    await refreshBoard(key, globalBoardBuilder(client, board));
    built++;
  }
  for (const guildId of guildsToWarm()) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    for (const board of GUILD_BOARD_IDS) {
      const key = leaderboardKeys.guild(guildId, board);
      const entry = getBoardEntry(key);
      if (entry?.complete && !entry.stale && Date.now() - entry.builtAt < GUILD_WARM_AGE_MS) continue;
      await yieldLoop();
      await refreshBoard(key, guildBoardBuilder(guild, board));
      built++;
    }
  }
  if (built > 0) log.debug(`warmed ${built} leaderboard(s) in ${Date.now() - started}ms`);
}

/** Boot: load the stored boards, then keep them warm. */
export function startLeaderboardWarmer(client: Client): void {
  const started = Date.now();
  const loaded = loadPersistedBoards();
  log.info(`loaded ${loaded} stored leaderboard(s) in ${Date.now() - started}ms`);
  let running = false;
  const pass = () => {
    if (running) return;
    running = true;
    void warmLeaderboards(client)
      .catch((error: unknown) => log.warn(`leaderboard warm pass failed: ${error instanceof Error ? error.message : error}`))
      .finally(() => {
        running = false;
      });
  };
  // First pass once the gateway has filled its caches.
  setTimeout(pass, 15_000).unref?.();
  setInterval(pass, WARM_INTERVAL_MS).unref?.();
}
