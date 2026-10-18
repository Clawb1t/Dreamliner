import type { Client, Guild, GuildMember, User } from "discord.js";

/**
 * Shared "who is this user" lookups for the dashboard's list endpoints (tickets, cases, logs,
 * reviews, suggestions, ...). Each row names a few people, and every endpoint used to ask Discord
 * for each one separately, every time: a 100-row page could queue hundreds of REST requests, and a
 * member who'd left cost a failed request on every page view.
 *
 * Here a lookup checks memory first, remembers the answer (including "not found") for a while,
 * shares one request between callers asking for the same person, and caps how many Discord
 * requests run at once.
 */

const FOUND_TTL_MS = 5 * 60_000;
const MISSING_TTL_MS = 2 * 60_000;
const MAX_ENTRIES = 5000;
const MAX_CONCURRENT = 8;

type Entry<T> = { value: Promise<T | null>; until: number };

const members = new Map<string, Entry<GuildMember>>();
const users = new Map<string, Entry<User>>();

let running = 0;
const waiting: Array<() => void> = [];

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await task();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function remember<T>(store: Map<string, Entry<T>>, key: string, load: () => Promise<T | null>): Promise<T | null> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.until > now) return hit.value;

  const value = limited(load).catch(() => null);
  // Provisional expiry; shortened once we know it was a miss.
  const entry: Entry<T> = { value, until: now + FOUND_TTL_MS };
  store.set(key, entry);
  void value.then((found) => {
    if (!found) entry.until = Date.now() + MISSING_TTL_MS;
  });
  if (store.size > MAX_ENTRIES) {
    for (const [k, v] of store) if (v.until <= now) store.delete(k);
    if (store.size > MAX_ENTRIES) store.clear();
  }
  return value;
}

/** A server member, from the gateway cache if present, else one shared (and remembered) request. */
export function fetchMemberCached(guild: Guild, userId: string): Promise<GuildMember | null> {
  const cachedMember = guild.members.cache.get(userId);
  if (cachedMember) return Promise.resolve(cachedMember);
  return remember(members, `${guild.id}:${userId}`, () => guild.members.fetch(userId));
}

/** Any Discord user, from cache if present, else one shared (and remembered) request. */
export function fetchUserCached(client: Client, userId: string): Promise<User | null> {
  const cachedUser = client.users.cache.get(userId);
  if (cachedUser) return Promise.resolve(cachedUser);
  return remember(users, userId, () => client.users.fetch(userId));
}
