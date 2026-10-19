import type { Client, Guild } from "discord.js";
import { getLogger } from "../core/logger.js";
import { cached, invalidateCached } from "./responseCache.js";

const log = getLogger("leaderboards");

/** Cache keys and lifetimes for the public leaderboards: shared by the routes and the pre-warmer so
 *  both fill the same entries. */
export const leaderboardKeys = {
  global: (limit: number) => `leaderboard:global:${limit}`,
  guild: (guildId: string, limit: number) => `leaderboard:guild:${guildId}:${limit}`,
  voice: (guildId: string, limit: number) => `leaderboard:voice:guild:${guildId}:${limit}`,
};
export const LEADERBOARD_TTL_MS = 60_000;

/**
 * A leaderboard through the page cache. A payload with names still being looked up (`partial`) is
 * dropped from the cache a few seconds later, so the next visitor gets the filled-in version
 * instead of waiting out the full TTL on placeholders.
 */
export async function leaderboardCached<T extends { partial?: boolean }>(key: string, ttlMs: number, build: () => Promise<T>): Promise<T> {
  const payload = await cached(key, ttlMs, build);
  if (payload.partial) setTimeout(() => invalidateCached(key), 4000).unref?.();
  return payload;
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
  const { buildWebPublicMessagerLeaderboard, buildWebPublicVoiceLeaderboard, buildWebGlobalPublicMessagerLeaderboard } = await import("./webStats.js");
  const started = Date.now();
  const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

  await leaderboardCached(leaderboardKeys.global(25), LEADERBOARD_TTL_MS, () => buildWebGlobalPublicMessagerLeaderboard(client, 25)).catch(
    (error) => log.warn(`prewarm of the global leaderboard failed: ${error instanceof Error ? error.message : error}`),
  );

  const guilds: Guild[] = [...client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount).slice(0, topGuilds);
  for (const guild of guilds) {
    await yieldLoop();
    await leaderboardCached(leaderboardKeys.guild(guild.id, 25), LEADERBOARD_TTL_MS, () => buildWebPublicMessagerLeaderboard(guild, 25)).catch(() => null);
    await yieldLoop();
    await leaderboardCached(leaderboardKeys.voice(guild.id, 25), LEADERBOARD_TTL_MS, () => buildWebPublicVoiceLeaderboard(guild, 25)).catch(() => null);
  }
  log.debug(`prewarmed leaderboards for ${guilds.length} servers in ${Date.now() - started}ms`);
}
