/**
 * Durable "who is this user" cache for leaderboard rows: display name, username, avatar, banner.
 *
 * A row is only ever published with a resolved identity (never a bare user ID), and builds never
 * make a visitor wait on Discord, so identities have to be on hand. Lookup order:
 *   1. memory (loaded from user_identity_cache in batches),
 *   2. the gateway's user cache (written through to the table),
 *   3. one Discord API fetch, through a small shared queue (QUEUE_CONCURRENCY at a time, one
 *      request per user, deduplicated), whose answer is stored.
 * Identities older than REFRESH_AFTER_MS are refreshed in the background through the same queue;
 * the stored copy keeps being used meanwhile.
 *
 * "Gone" (never shown): Discord says the user doesn't exist (10013 Unknown User), or the account is
 * deleted ("deleted_user_..."). A user whose lookups keep failing for other reasons (FAILURES_FOR_GONE
 * attempts in a row) is treated as unreachable for UNREACHABLE_MS, so one broken lookup can't stop a
 * board from ever completing. Global boards include anyone the bot can resolve, whether or not it
 * shares a server with them.
 */
import type { Client, User } from "discord.js";
import { inArray } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { userIdentityCache } from "../db/schema.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("identities");

export const REFRESH_AFTER_MS = 24 * 60 * 60_000;
/** A "gone" answer is re-checked after this long (accounts can be restored within Discord's grace period). */
const GONE_RECHECK_MS = 7 * 24 * 60 * 60_000;
const QUEUE_CONCURRENCY = 3;
const FAILURES_FOR_GONE = 3;
const UNREACHABLE_MS = 30 * 60_000;
const FAILURE_BACKOFF_MS = 60_000;
const MAX_MEMORY = 50_000;

export type StoredIdentity = {
  userId: string;
  username: string | null;
  globalName: string | null;
  avatar: string | null;
  banner: string | null;
  gone: boolean;
  /** Last full API fetch (ms), 0 = only seen in the gateway cache. */
  fetchedAt: number;
  updatedAt: number;
};

/** What a leaderboard row shows. `avatar` is always a URL (Discord's default avatar when unset). */
export type ShownIdentity = {
  name: string;
  username: string | null;
  avatar: string;
  bannerUrl: string | null;
};

/** The bits of a discord.js Client used here (tests pass a stub). */
export type IdentityClient = Pick<Client, "users">;

const memory = new Map<string, StoredIdentity>();
/** Users whose fetch is queued or running, shared by every caller. */
const pending = new Map<string, Promise<StoredIdentity | null>>();
const failures = new Map<string, { count: number; until: number }>();
const queue: Array<() => void> = [];
let running = 0;

// --- Pure helpers --------------------------------------------------------------------------------

const CDN = "https://cdn.discordapp.com";

/** Discord's default avatar for accounts without one (new username system formula). */
export function defaultAvatarUrl(userId: string): string {
  let index = 0;
  try {
    index = Number((BigInt(userId) >> 22n) % 6n);
  } catch {
    index = 0;
  }
  return `${CDN}/embed/avatars/${index}.png`;
}

export function avatarUrl(userId: string, hash: string | null): string {
  if (!hash) return defaultAvatarUrl(userId);
  return `${CDN}/avatars/${userId}/${hash}.${hash.startsWith("a_") ? "gif" : "webp"}?size=64`;
}

export function bannerUrl(userId: string, hash: string | null): string | null {
  if (!hash) return null;
  return `${CDN}/banners/${userId}/${hash}.${hash.startsWith("a_") ? "gif" : "png"}?size=512`;
}

export function isDeletedAccount(user: { username?: string | null; globalName?: string | null }): boolean {
  const username = user.username ?? "";
  return /^deleted_user_[0-9a-f]+$/i.test(username) || username === "Deleted User";
}

/** The row identity for a stored record, or null when it can't be shown. */
export function shownIdentity(record: StoredIdentity | undefined | null, displayName?: string | null): ShownIdentity | null {
  if (!record || record.gone) return null;
  const name = displayName?.trim() || record.globalName?.trim() || record.username?.trim();
  if (!name) return null;
  return {
    name,
    username: record.username,
    avatar: avatarUrl(record.userId, record.avatar),
    bannerUrl: bannerUrl(record.userId, record.banner),
  };
}

// --- Storage -------------------------------------------------------------------------------------

function remember(record: StoredIdentity): void {
  memory.delete(record.userId);
  memory.set(record.userId, record);
  if (memory.size > MAX_MEMORY) {
    const drop = memory.size - MAX_MEMORY;
    let i = 0;
    for (const key of memory.keys()) {
      if (i++ >= drop) break;
      memory.delete(key);
    }
  }
}

function persist(record: StoredIdentity): void {
  try {
    const { userId, ...rest } = record;
    getDb()
      .insert(userIdentityCache)
      .values(record)
      .onConflictDoUpdate({ target: userIdentityCache.userId, set: rest })
      .run();
  } catch (error) {
    log.debug(`storing identity ${record.userId} failed: ${error instanceof Error ? error.message : error}`);
  }
}

function store(record: StoredIdentity): StoredIdentity {
  remember(record);
  persist(record);
  return record;
}

/** Loads any of `ids` not in memory from the table, in one query per 500. */
function loadFromDb(ids: readonly string[]): void {
  const missing = ids.filter((id) => !memory.has(id));
  for (let i = 0; i < missing.length; i += 500) {
    const chunk = missing.slice(i, i + 500);
    try {
      const rows = getDb().select().from(userIdentityCache).where(inArray(userIdentityCache.userId, chunk)).all();
      for (const row of rows) remember(row);
    } catch (error) {
      log.debug(`loading identities failed: ${error instanceof Error ? error.message : error}`);
      return;
    }
  }
}

function fromUser(user: User, fetched: boolean, previous?: StoredIdentity): StoredIdentity {
  const now = Date.now();
  return {
    userId: user.id,
    username: user.username ?? null,
    globalName: user.globalName ?? null,
    avatar: user.avatar ?? null,
    // A gateway-cached user's banner isn't reliable (often null/undefined even when set): keep the
    // last fetched one until the next full fetch.
    banner: fetched ? (user.banner ?? null) : (previous?.banner ?? null),
    gone: isDeletedAccount(user),
    fetchedAt: fetched ? now : (previous?.fetchedAt ?? 0),
    updatedAt: now,
  };
}

// --- Fetch queue ---------------------------------------------------------------------------------

function slot(): Promise<void> {
  if (running < QUEUE_CONCURRENCY) {
    running++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => queue.push(resolve)).then(() => {
    running++;
  });
}

function release(): void {
  running--;
  queue.shift()?.();
}

function isUnknownUser(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 10013 || (error as { status?: unknown } | null)?.status === 404;
}

/** One API fetch for `userId`, shared by every caller asking at the same time. Null = no answer yet. */
function fetchIdentity(client: IdentityClient, userId: string): Promise<StoredIdentity | null> {
  const running = pending.get(userId);
  if (running) return running;
  const failure = failures.get(userId);
  if (failure && failure.until > Date.now()) return Promise.resolve(null);
  const work = (async () => {
    await slot();
    try {
      const user = await client.users.fetch(userId, { force: true, cache: false });
      failures.delete(userId);
      return store(fromUser(user, true, memory.get(userId)));
    } catch (error) {
      if (isUnknownUser(error)) {
        failures.delete(userId);
        const now = Date.now();
        return store({ userId, username: null, globalName: null, avatar: null, banner: null, gone: true, fetchedAt: now, updatedAt: now });
      }
      const count = (failures.get(userId)?.count ?? 0) + 1;
      failures.set(userId, { count, until: Date.now() + (count >= FAILURES_FOR_GONE ? UNREACHABLE_MS : FAILURE_BACKOFF_MS) });
      log.debug(`identity fetch for ${userId} failed (${count}): ${error instanceof Error ? error.message : error}`);
      return null;
    } finally {
      release();
    }
  })().finally(() => pending.delete(userId));
  pending.set(userId, work);
  return work;
}

function isStale(record: StoredIdentity, now: number): boolean {
  if (record.gone) return now - record.fetchedAt > GONE_RECHECK_MS;
  return now - record.fetchedAt > REFRESH_AFTER_MS;
}

/** Unreachable after repeated failures: excluded like a gone account, until the window passes. */
function isUnreachable(userId: string, now: number): boolean {
  const failure = failures.get(userId);
  return Boolean(failure && failure.count >= FAILURES_FOR_GONE && failure.until > now);
}

// --- Public API ----------------------------------------------------------------------------------

export type IdentityLookup = {
  /** Shown-ready identities. */
  found: Map<string, StoredIdentity>;
  /** Definitively not shown: deleted, unknown or unreachable. */
  gone: Set<string>;
  /** No answer yet (lookup still running, failed for now, or `fetch: false`). */
  pending: Set<string>;
};

/**
 * Identities for `userIds`. With `fetch`, users nobody knows yet are fetched (queued) and awaited
 * until `deadline` (ms timestamp); without it only stored and gateway-cached identities count.
 * Stale identities are always refreshed in the background, never awaited.
 */
export async function resolveIdentities(
  client: IdentityClient,
  userIds: readonly string[],
  options: { fetch: boolean; deadline?: number } = { fetch: true },
): Promise<IdentityLookup> {
  const ids = [...new Set(userIds)];
  const now = Date.now();
  loadFromDb(ids);
  const result: IdentityLookup = { found: new Map(), gone: new Set(), pending: new Set() };
  const toFetch: string[] = [];
  for (const id of ids) {
    let record = memory.get(id);
    const cachedUser = client.users.cache.get(id);
    if (cachedUser) {
      // Gateway copy: freshest name/avatar, no request. Written through when it changed.
      const next = fromUser(cachedUser, false, record);
      if (!record || record.username !== next.username || record.globalName !== next.globalName || record.avatar !== next.avatar) {
        record = store(next);
      }
    }
    if (record) {
      if (isStale(record, now)) void fetchIdentity(client, id).catch(() => null);
      if (record.gone) result.gone.add(id);
      else result.found.set(id, record);
      continue;
    }
    if (isUnreachable(id, now)) {
      result.gone.add(id);
      continue;
    }
    toFetch.push(id);
  }
  if (toFetch.length === 0) return result;
  if (!options.fetch) {
    for (const id of toFetch) {
      result.pending.add(id);
      void fetchIdentity(client, id).catch(() => null); // ready for the next build
    }
    return result;
  }
  const deadline = options.deadline ?? Infinity;
  await Promise.all(
    toFetch.map(async (id) => {
      const work = fetchIdentity(client, id);
      const left = deadline - Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answer =
        left === Infinity
          ? await work
          : left <= 0
            ? undefined
            : await Promise.race([
                work,
                new Promise<undefined>((resolve) => {
                  timer = setTimeout(() => resolve(undefined), left);
                }),
              ]).finally(() => timer && clearTimeout(timer));
      if (answer && !answer.gone) result.found.set(id, answer);
      else if (answer?.gone || isUnreachable(id, Date.now())) result.gone.add(id);
      else result.pending.add(id);
    }),
  );
  return result;
}

/** Drops a user's stored identity (data erase). */
export function forgetIdentity(userId: string): void {
  memory.delete(userId);
  failures.delete(userId);
}

/** Tests only: clears memory and failure state (the table is left alone, like a restart). */
export function resetIdentityMemory(): void {
  memory.clear();
  failures.clear();
  pending.clear();
}

/** Bench/diagnostics. */
export function identityQueueDepth(): { running: number; queued: number; pending: number } {
  return { running, queued: queue.length, pending: pending.size };
}
