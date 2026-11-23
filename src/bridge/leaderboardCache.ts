import type { Client, Guild } from "discord.js";
import { getLogger } from "../core/logger.js";
import { cached, refreshCached } from "./responseCache.js";
import { listHiddenFromGlobalBoards } from "../core/privacy/ghostMode.js";

const log = getLogger("leaderboards");

/** Cache keys and lifetimes for the public leaderboards: shared by the routes and the pre-warmer so
 *  both fill the same entries. */
export const leaderboardKeys = {
  global: (limit: number) => `leaderboard:global:${limit}`,
  globalBoard: (board: string, limit: number) => `leaderboard:global:${board}:${limit}`,
  guild: (guildId: string, limit: number) => `leaderboard:guild:${guildId}:${limit}`,
  voice: (guildId: string, limit: number) => `leaderboard:voice:guild:${guildId}:${limit}`,
  guildBoard: (guildId: string, board: string, limit: number) => `leaderboard:${board}:guild:${guildId}:${limit}`,
};
export const LEADERBOARD_TTL_MS = 60_000;
/** Rows the website's global leaderboard page asks for on every board (it pages through them). */
export const GLOBAL_PAGE_LIMIT = 50;

/** Background re-resolve passes for a board whose names were still being looked up. */
const FILL_IN_DELAYS_MS = [2500, 6000, 15_000, 40_000];
const fillingIn = new Set<string>();

/**
 * Rebuilds a `partial` board in the background until every name and avatar is filled in. Name
 * lookups that ran out of time keep going and land in the identity cache, so a rebuild a few
 * seconds later normally resolves everyone from cache. The cached copy is replaced each pass, so
 * visitors move from IDs to real names without waiting on anything.
 */
function fillIn<T extends { partial?: boolean }>(key: string, ttlMs: number, build: () => Promise<T>, pass = 0): void {
  if (pass === 0) {
    if (fillingIn.has(key)) return;
    fillingIn.add(key);
  }
  const delay = FILL_IN_DELAYS_MS[pass];
  if (delay === undefined) {
    fillingIn.delete(key);
    return;
  }
  setTimeout(() => {
    refreshCached(key, ttlMs, build)
      .then((next) => {
        if (next.partial) fillIn(key, ttlMs, build, pass + 1);
        else fillingIn.delete(key);
      })
      .catch((error: unknown) => {
        log.debug(`filling in ${key} failed: ${error instanceof Error ? error.message : error}`);
        fillIn(key, ttlMs, build, pass + 1);
      });
  }, delay).unref?.();
}

/**
 * A leaderboard through the page cache (stale-while-revalidate). A payload with names still being
 * looked up (`partial`) is rebuilt in the background a few times until it's complete (fillIn),
 * instead of being dropped (dropping made the next visitor wait on a full rebuild, and the site
 * gave up and showed the board as unavailable) or left showing IDs.
 */
export async function leaderboardCached<T extends { partial?: boolean }>(key: string, ttlMs: number, build: () => Promise<T>): Promise<T> {
  const payload = await cached(key, ttlMs, build);
  if (payload.partial) fillIn(key, ttlMs, build);
  return payload;
}

/**
 * A global board payload with anyone now in Ghost Mode (or hidden from global boards) taken out
 * and the rest renumbered. Applied on every response, so a cached board never shows someone who
 * just turned Ghost Mode on, while the board itself can be served from cache without a rebuild.
 */
export function withoutHiddenLeaders<T>(payload: T): T {
  const leaders = (payload as { leaders?: Array<{ id?: string; rank?: number }> }).leaders;
  if (!Array.isArray(leaders) || leaders.length === 0) return payload;
  const hidden = listHiddenFromGlobalBoards();
  if (hidden.size === 0 || !leaders.some((row) => row.id && hidden.has(row.id))) return payload;
  const kept = leaders.filter((row) => !(row.id && hidden.has(row.id))).map((row, index) => ({ ...row, rank: index + 1 }));
  return { ...payload, leaders: kept };
}

/**
 * Keeps the busiest leaderboards (global and the few biggest servers) warm so visitors are served
 * from memory instead of triggering a rebuild.
 *
 * Kept deliberately small: every board row can need Discord requests (member, user, banner), and
 * a pass over 25 servers measured ~1,300 requests. Those share the bot's Discord request queue with
 * everything else, so a big pass made unrelated requests (like a profile's user lookup) wait behind
 * it until the website gave up. Each pass only rebuilds what has gone stale, one board at a time.
 */
export const PREWARM_TOP_GUILDS = 5;
export const PREWARM_INTERVAL_MS = 5 * 60_000;
export async function prewarmLeaderboards(client: Client, topGuilds = PREWARM_TOP_GUILDS): Promise<void> {
  const {
    buildWebPublicMessagerLeaderboard,
    buildWebPublicVoiceLeaderboard,
    buildWebGlobalPublicMessagerLeaderboard,
    buildWebGlobalPublicBoard,
    GLOBAL_PUBLIC_BOARDS,
  } = await import("./webStats.js");
  const started = Date.now();
  const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

  await leaderboardCached(leaderboardKeys.global(GLOBAL_PAGE_LIMIT), LEADERBOARD_TTL_MS, () =>
    buildWebGlobalPublicMessagerLeaderboard(client, GLOBAL_PAGE_LIMIT),
  ).catch((error) => log.warn(`prewarm of the global leaderboard failed: ${error instanceof Error ? error.message : error}`));
  for (const board of GLOBAL_PUBLIC_BOARDS) {
    await yieldLoop();
    await leaderboardCached(leaderboardKeys.globalBoard(board, GLOBAL_PAGE_LIMIT), LEADERBOARD_TTL_MS, () =>
      buildWebGlobalPublicBoard(client, board, GLOBAL_PAGE_LIMIT),
    ).catch((error) => log.warn(`prewarm of the global ${board} board failed: ${error instanceof Error ? error.message : error}`));
  }

  const guilds: Guild[] = [...client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount).slice(0, topGuilds);
  for (const guild of guilds) {
    await yieldLoop();
    await leaderboardCached(leaderboardKeys.guild(guild.id, 25), LEADERBOARD_TTL_MS, () => buildWebPublicMessagerLeaderboard(guild, 25)).catch(() => null);
    await yieldLoop();
    await leaderboardCached(leaderboardKeys.voice(guild.id, 25), LEADERBOARD_TTL_MS, () => buildWebPublicVoiceLeaderboard(guild, 25)).catch(() => null);
  }
  log.debug(`prewarmed leaderboards for ${guilds.length} servers in ${Date.now() - started}ms`);
}
