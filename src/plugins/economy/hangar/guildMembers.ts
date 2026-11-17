import type { Guild } from "discord.js";
import { rankedUserIds } from "./leaderboards.js";

const cache = new Map<string, { ids: string[]; until: number }>();
const TTL_MS = 60_000;

/**
 * Which Hangar players are members of this guild. Checks the member cache first, then asks the
 * gateway for the rest in batches of 100. Cached per guild for a minute, so a per-server
 * leaderboard only ever contains that server's members.
 */
export async function hangarMembersOf(guild: Guild): Promise<string[]> {
  const hit = cache.get(guild.id);
  if (hit && hit.until > Date.now()) return hit.ids;
  const candidates = rankedUserIds();
  const members = new Set<string>();
  const unknown: string[] = [];
  for (const id of candidates) {
    if (guild.members.cache.has(id)) members.add(id);
    else unknown.push(id);
  }
  for (let i = 0; i < unknown.length && i < 5000; i += 100) {
    const chunk = unknown.slice(i, i + 100);
    try {
      const fetched = await guild.members.fetch({ user: chunk, time: 10_000 });
      for (const id of fetched.keys()) members.add(id);
    } catch {
      /* a failed batch just leaves those users out */
    }
  }
  const ids = [...members];
  cache.set(guild.id, { ids, until: Date.now() + TTL_MS });
  if (cache.size > 2000) cache.clear();
  return ids;
}
