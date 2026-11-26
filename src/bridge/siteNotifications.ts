/**
 * Website notifications: the bell in the site's navbar, written by platform superusers.
 *
 *   Superuser (all writes re-check isDashboardSuperuser on the bot):
 *     GET    /bridge/platform/notifications?userId=         -> list with reach/read counts + plugin names
 *     POST   /bridge/platform/notifications                 { userId, ...fields } -> created
 *     PUT    /bridge/platform/notifications/:id             { userId, ...partial fields } -> updated
 *     DELETE /bridge/platform/notifications/:id             { userId } (also drops everyone's state rows)
 *     POST   /bridge/platform/notifications/estimate        { userId, audience } -> rough audience size
 *
 *   Signed-in user (the website puts the session's Discord id in the path):
 *     POST   /bridge/users/:id/notifications/feed           { view: "count" | "list", guilds? } -> unread (+ items)
 *     POST   /bridge/users/:id/notifications/read           { ids?: number[], all?: true }
 *     POST   /bridge/users/:id/notifications/:nid/dismiss
 *
 * Audiences are matched when a user asks for their feed, never fanned out per user. A user's
 * matched set is cached for a minute (and dropped on every write here); read state is read fresh
 * so "mark as read" shows at once. The feed only ever returns a notification's own display fields:
 * never its audience, so nobody learns which servers or people it was aimed at.
 *
 * Which servers a user shares with the bot comes from what the bot knows itself (server owners,
 * cached members, kept for staff by clientCache.ts) plus the user's own server list, which the
 * website reads from Discord with the user's OAuth token and passes as `guilds`. Hints are only
 * used for servers the bot is in, and only decide which broadcasts the user sees. Without hints
 * (Discord's list failed), a few member lookups per request fill the gaps, memoised.
 */
import { and, count, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Client, Guild } from "discord.js";
import { PermissionFlagsBits } from "discord.js";
import { getDb } from "../db/client.js";
import { siteNotificationState, siteNotifications } from "../db/schema.js";
import { capMap, createPruner } from "../core/mapPrune.js";
import { cachedSwr, invalidateCached } from "./responseCache.js";
import { SlidingWindowLimiter } from "./rateLimit.js";
import {
  audienceMatches,
  audienceSchema,
  createNotificationSchema,
  firstIssue,
  isLive,
  NOTIFICATION_KINDS,
  NOTIFICATION_STATUSES,
  sortForFeed,
  updateNotificationSchema,
  type Membership,
  type NotificationAudience,
  type NotificationKind,
  type NotificationStatus,
  type StoredNotification,
} from "./siteNotificationsModel.js";

export type NotificationResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/** How the feed finds servers and memberships. Injected so tests run without Discord. */
export type NotificationDeps = {
  /** Plugin names that exist right now (read from availablePlugins, so removed ones match nobody). */
  pluginNames(): Promise<string[]>;
  /** Servers the bot is in. */
  botGuildIds(): Set<string>;
  /** Servers where `plugin` is switched on. */
  guildsWithPlugin(plugin: string): Promise<Set<string>>;
  /** Of `guildIds`, the ones the user is in and whether they manage them. */
  memberships(userId: string, guildIds: Set<string>, hints: GuildHint[] | null): Promise<Map<string, Membership>>;
  /** Rough member count of a server (for the composer's estimate). */
  memberCount(guildId: string): number;
};

/** One entry of the user's own server list, from Discord via the website's OAuth session. */
export type GuildHint = { id: string; manager: boolean };

// --- Rows -------------------------------------------------------------------------------------

function toStored(row: typeof siteNotifications.$inferSelect): StoredNotification | null {
  let audience: NotificationAudience;
  try {
    const parsed = audienceSchema.safeParse(JSON.parse(row.audience));
    if (!parsed.success) return null;
    audience = parsed.data;
  } catch {
    return null;
  }
  return {
    id: row.id,
    kind: (NOTIFICATION_KINDS as readonly string[]).includes(row.kind) ? (row.kind as NotificationKind) : "announcement",
    title: row.title,
    body: row.body,
    linkUrl: row.linkUrl ?? null,
    linkLabel: row.linkLabel ?? null,
    icon: row.icon ?? null,
    audience,
    status: (NOTIFICATION_STATUSES as readonly string[]).includes(row.status) ? (row.status as NotificationStatus) : "draft",
    pinned: row.pinned,
    publishedAt: row.publishedAt ?? null,
    expiresAt: row.expiresAt ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function allNotifications(): StoredNotification[] {
  return getDb()
    .select()
    .from(siteNotifications)
    .all()
    .map(toStored)
    .filter((n): n is StoredNotification => n !== null);
}

function liveNotifications(now = Date.now()): StoredNotification[] {
  return getDb()
    .select()
    .from(siteNotifications)
    .where(and(eq(siteNotifications.status, "published"), isNotNull(siteNotifications.publishedAt)))
    .all()
    .map(toStored)
    .filter((n): n is StoredNotification => n !== null && isLive(n, now));
}

function getNotification(id: number): StoredNotification | null {
  const row = getDb().select().from(siteNotifications).where(eq(siteNotifications.id, id)).get();
  return row ? toStored(row) : null;
}

/** Every cached per-user feed and per-plugin server list is dropped after a write. */
function invalidateFeeds(): void {
  invalidateCached("notif-user:");
}

// --- Audience resolution ------------------------------------------------------------------------

/** The servers a server-based audience points at, limited to servers the bot is in. Null for the others. */
async function targetGuilds(audience: NotificationAudience, deps: NotificationDeps): Promise<Set<string> | null> {
  if (audience.type === "servers") {
    const bot = deps.botGuildIds();
    return new Set(audience.guildIds.filter((id) => bot.has(id)));
  }
  if (audience.type === "feature") {
    if (!(await deps.pluginNames()).includes(audience.plugin)) return new Set();
    return deps.guildsWithPlugin(audience.plugin);
  }
  return null;
}

/** Ids of the live notifications whose audience includes this user (uncached). */
export async function computeMatchedIds(userId: string, deps: NotificationDeps, hints: GuildHint[] | null, now = Date.now()): Promise<number[]> {
  const live = liveNotifications(now);
  const targets = new Map<number, Set<string> | null>();
  const needed = new Set<string>();
  for (const notification of live) {
    const set = await targetGuilds(notification.audience, deps);
    targets.set(notification.id, set);
    for (const id of set ?? []) needed.add(id);
  }
  const memberships = needed.size ? await deps.memberships(userId, needed, hints) : new Map<string, Membership>();
  return live.filter((n) => audienceMatches(n.audience, userId, targets.get(n.id) ?? null, memberships)).map((n) => n.id);
}

function matchedIds(userId: string, deps: NotificationDeps, hints: GuildHint[] | null): Promise<number[]> {
  return cachedSwr(`notif-user:${userId}`, 60_000, 5 * 60_000, () => computeMatchedIds(userId, deps, hints));
}

// --- The user's feed ----------------------------------------------------------------------------

export type FeedItem = {
  id: number;
  kind: NotificationKind;
  title: string;
  body: string;
  linkUrl: string | null;
  linkLabel: string | null;
  icon: string | null;
  pinned: boolean;
  publishedAt: string;
  read: boolean;
};

export type Feed = { unread: number; items?: FeedItem[] };

const FEED_LIMIT = 30;

function stateRows(userId: string, ids: number[]) {
  if (!ids.length) return new Map<number, typeof siteNotificationState.$inferSelect>();
  const rows = getDb()
    .select()
    .from(siteNotificationState)
    .where(and(eq(siteNotificationState.userId, userId), inArray(siteNotificationState.notificationId, ids)))
    .all();
  return new Map(rows.map((row) => [row.notificationId, row]));
}

export async function getUserFeed(
  userId: string,
  view: "count" | "list",
  deps: NotificationDeps,
  hints: GuildHint[] | null,
  now = Date.now(),
): Promise<Feed> {
  const ids = await matchedIds(userId, deps, hints);
  // The cached set can be up to a minute old: drop anything that expired or was pulled since.
  const live = new Map(liveNotifications(now).map((n) => [n.id, n]));
  const visible = ids.map((id) => live.get(id)).filter((n): n is StoredNotification => Boolean(n));
  const state = stateRows(userId, visible.map((n) => n.id));
  const shown = sortForFeed(visible.filter((n) => !state.get(n.id)?.dismissedAt));
  const unread = shown.filter((n) => !state.get(n.id)?.readAt).length;
  if (view === "count") return { unread };

  const items = shown.slice(0, FEED_LIMIT);
  // First time each one shows in the list: that's the composer's "reach".
  const unseen = items.filter((n) => !state.get(n.id)?.seenAt);
  if (unseen.length) {
    getDb()
      .insert(siteNotificationState)
      .values(unseen.map((n) => ({ userId, notificationId: n.id, seenAt: now })))
      .onConflictDoUpdate({
        target: [siteNotificationState.userId, siteNotificationState.notificationId],
        set: { seenAt: sql`coalesce(${siteNotificationState.seenAt}, excluded.seen_at)` },
      })
      .run();
  }
  return {
    unread,
    items: items.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      linkUrl: n.linkUrl,
      linkLabel: n.linkLabel,
      icon: n.icon,
      pinned: n.pinned,
      publishedAt: new Date(n.publishedAt ?? n.createdAt).toISOString(),
      read: Boolean(state.get(n.id)?.readAt),
    })),
  };
}

/** Marks some (or all) of the user's own notifications read. Ids outside their feed are ignored. */
export async function markRead(userId: string, input: { ids?: unknown; all?: unknown }, deps: NotificationDeps, now = Date.now()): Promise<NotificationResult<{ unread: number }>> {
  const mine = new Set(await matchedIds(userId, deps, null));
  let ids: number[];
  if (input.all === true) ids = [...mine];
  else if (Array.isArray(input.ids) && input.ids.length <= 100) ids = input.ids.filter((id): id is number => Number.isInteger(id) && mine.has(id as number));
  else return { ok: false, status: 400, error: "Send ids or all." };
  if (ids.length) {
    getDb()
      .insert(siteNotificationState)
      .values(ids.map((notificationId) => ({ userId, notificationId, seenAt: now, readAt: now })))
      .onConflictDoUpdate({
        target: [siteNotificationState.userId, siteNotificationState.notificationId],
        set: {
          seenAt: sql`coalesce(${siteNotificationState.seenAt}, excluded.seen_at)`,
          readAt: sql`coalesce(${siteNotificationState.readAt}, excluded.read_at)`,
        },
      })
      .run();
  }
  const feed = await getUserFeed(userId, "count", deps, null, now);
  return { ok: true, value: { unread: feed.unread } };
}

/** Hides one notification from the user's list for good (it also counts as read). */
export async function dismiss(userId: string, notificationId: number, deps: NotificationDeps, now = Date.now()): Promise<NotificationResult<{ unread: number }>> {
  const mine = new Set(await matchedIds(userId, deps, null));
  if (!mine.has(notificationId)) return { ok: false, status: 404, error: "Notification not found." };
  getDb()
    .insert(siteNotificationState)
    .values({ userId, notificationId, seenAt: now, readAt: now, dismissedAt: now })
    .onConflictDoUpdate({
      target: [siteNotificationState.userId, siteNotificationState.notificationId],
      set: {
        seenAt: sql`coalesce(${siteNotificationState.seenAt}, excluded.seen_at)`,
        readAt: sql`coalesce(${siteNotificationState.readAt}, excluded.read_at)`,
        dismissedAt: sql`coalesce(${siteNotificationState.dismissedAt}, excluded.dismissed_at)`,
      },
    })
    .run();
  const feed = await getUserFeed(userId, "count", deps, null, now);
  return { ok: true, value: { unread: feed.unread } };
}

/** Cleans the website's guild hints: at most 250 snowflakes with a manager flag. */
export function normalizeGuildHints(raw: unknown): GuildHint[] | null {
  if (!Array.isArray(raw)) return null;
  const out: GuildHint[] = [];
  for (const entry of raw.slice(0, 250)) {
    if (!entry || typeof entry !== "object") continue;
    const { id, manager } = entry as { id?: unknown; manager?: unknown };
    if (typeof id === "string" && /^\d{15,22}$/.test(id)) out.push({ id, manager: manager === true });
  }
  return out;
}

// --- Superuser composer -------------------------------------------------------------------------

export type AdminNotification = Omit<StoredNotification, "publishedAt" | "expiresAt" | "createdAt" | "updatedAt"> & {
  publishedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  state: "draft" | "scheduled" | "live" | "expired";
  stats: { seen: number; read: number; dismissed: number };
};

function toAdmin(n: StoredNotification, stats: AdminNotification["stats"], now = Date.now()): AdminNotification {
  const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
  const state: AdminNotification["state"] =
    n.status === "draft" ? "draft" : n.expiresAt != null && n.expiresAt <= now ? "expired" : isLive(n, now) ? "live" : "scheduled";
  return {
    ...n,
    publishedAt: iso(n.publishedAt),
    expiresAt: iso(n.expiresAt),
    createdAt: new Date(n.createdAt).toISOString(),
    updatedAt: new Date(n.updatedAt).toISOString(),
    state,
    stats,
  };
}

function statsFor(ids: number[]): Map<number, AdminNotification["stats"]> {
  if (!ids.length) return new Map();
  const rows = getDb()
    .select({
      id: siteNotificationState.notificationId,
      seen: count(siteNotificationState.seenAt),
      read: count(siteNotificationState.readAt),
      dismissed: count(siteNotificationState.dismissedAt),
    })
    .from(siteNotificationState)
    .where(inArray(siteNotificationState.notificationId, ids))
    .groupBy(siteNotificationState.notificationId)
    .all();
  return new Map(rows.map((row) => [row.id, { seen: Number(row.seen), read: Number(row.read), dismissed: Number(row.dismissed) }]));
}

const EMPTY_STATS = { seen: 0, read: 0, dismissed: 0 };

export function listAdminNotifications(now = Date.now()): AdminNotification[] {
  const all = allNotifications().sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  const stats = statsFor(all.map((n) => n.id));
  return all.map((n) => toAdmin(n, stats.get(n.id) ?? EMPTY_STATS, now));
}

export function createNotification(raw: unknown, createdBy: string, now = Date.now()): NotificationResult<AdminNotification> {
  const parsed = createNotificationSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 400, error: firstIssue(parsed.error) };
  const input = parsed.data;
  if (input.expiresAt != null && input.expiresAt <= now) return { ok: false, status: 400, error: "The expiry must be in the future." };
  const row = getDb()
    .insert(siteNotifications)
    .values({
      kind: input.kind,
      title: input.title,
      body: input.body,
      linkUrl: input.linkUrl ?? null,
      linkLabel: input.linkUrl ? (input.linkLabel ?? null) : null,
      icon: input.icon ?? null,
      audience: JSON.stringify(input.audience),
      status: input.status,
      pinned: input.pinned,
      publishedAt: input.status === "published" ? now : null,
      expiresAt: input.expiresAt ?? null,
      createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  invalidateFeeds();
  const stored = toStored(row);
  if (!stored) return { ok: false, status: 500, error: "Couldn't save that notification." };
  return { ok: true, value: toAdmin(stored, EMPTY_STATS, now) };
}

export function updateNotification(id: number, raw: unknown, now = Date.now()): NotificationResult<AdminNotification> {
  const existing = getNotification(id);
  if (!existing) return { ok: false, status: 404, error: "Notification not found." };
  const parsed = updateNotificationSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 400, error: firstIssue(parsed.error) };
  const input = parsed.data;
  const patch: Partial<typeof siteNotifications.$inferInsert> = { updatedAt: now };
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.title !== undefined) patch.title = input.title;
  if (input.body !== undefined) patch.body = input.body;
  if (input.icon !== undefined) patch.icon = input.icon ?? null;
  if (input.audience !== undefined) patch.audience = JSON.stringify(input.audience);
  if (input.pinned !== undefined) patch.pinned = input.pinned;
  if (input.linkUrl !== undefined) patch.linkUrl = input.linkUrl ?? null;
  if (input.linkLabel !== undefined) patch.linkLabel = input.linkLabel ?? null;
  const nextLink = input.linkUrl !== undefined ? (input.linkUrl ?? null) : existing.linkUrl;
  if (!nextLink) patch.linkLabel = null;
  if (input.expiresAt !== undefined) {
    if (input.expiresAt != null && input.expiresAt <= now && input.expiresAt !== existing.expiresAt) {
      return { ok: false, status: 400, error: "The expiry must be in the future." };
    }
    patch.expiresAt = input.expiresAt ?? null;
  }
  if (input.status !== undefined && input.status !== existing.status) {
    patch.status = input.status;
    // A fresh publish goes to the top of everyone's list; unpublishing keeps the old time until then.
    if (input.status === "published") patch.publishedAt = now;
  }
  const row = getDb().update(siteNotifications).set(patch).where(eq(siteNotifications.id, id)).returning().get();
  invalidateFeeds();
  const stored = row ? toStored(row) : null;
  if (!stored) return { ok: false, status: 500, error: "Couldn't save that notification." };
  return { ok: true, value: toAdmin(stored, statsFor([id]).get(id) ?? EMPTY_STATS, now) };
}

export function deleteNotification(id: number): boolean {
  const db = getDb();
  const deleted = db.delete(siteNotifications).where(eq(siteNotifications.id, id)).returning({ id: siteNotifications.id }).get();
  if (!deleted) return false;
  db.delete(siteNotificationState).where(eq(siteNotificationState.notificationId, id)).run();
  invalidateFeeds();
  return true;
}

export type AudienceEstimate = {
  /** Servers the audience covers (null for everyone and specific users). */
  servers: number | null;
  /** Approximate people: summed member counts (overlaps counted twice), or the id count. */
  people: number | null;
  scope: "everyone" | "members" | "managers" | "users";
};

export async function estimateAudience(raw: unknown, deps: NotificationDeps): Promise<NotificationResult<AudienceEstimate>> {
  const parsed = audienceSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 400, error: firstIssue(parsed.error) };
  const audience = parsed.data;
  if (audience.type === "everyone") return { ok: true, value: { servers: null, people: null, scope: "everyone" } };
  if (audience.type === "users") return { ok: true, value: { servers: null, people: audience.userIds.length, scope: "users" } };
  const guilds = (await targetGuilds(audience, deps)) ?? new Set<string>();
  // Managers: no cheap count, so the server count stands in (at least the owner of each).
  const people = audience.scope === "members" ? [...guilds].reduce((sum, id) => sum + deps.memberCount(id), 0) : null;
  return { ok: true, value: { servers: guilds.size, people, scope: audience.scope } };
}

// --- Personal data (erase + export) --------------------------------------------------------------

export function countUserNotificationState(userId: string): number {
  const row = getDb().select({ total: count() }).from(siteNotificationState).where(eq(siteNotificationState.userId, userId)).get();
  return Number(row?.total ?? 0);
}

export function deleteUserNotificationState(userId: string): number {
  const deleted = getDb().delete(siteNotificationState).where(eq(siteNotificationState.userId, userId)).returning().all().length;
  invalidateCached(`notif-user:${userId}`);
  return deleted;
}

export function exportUserNotificationState(userId: string) {
  return getDb().select().from(siteNotificationState).where(eq(siteNotificationState.userId, userId)).all();
}

// --- Production deps (Discord client + configManager) -------------------------------------------

type MemoEntry = { member: boolean; manager: boolean; until: number };
const memberMemo = new Map<string, MemoEntry>();
const pruneMemo = createPruner(memberMemo, (entry, now) => entry.until <= now);
/** Member lookups for the feed across every user, so a burst can't flood Discord. */
const lookupLimiter = new SlidingWindowLimiter(120, 60_000);
const MAX_LOOKUPS_PER_FEED = 5;
const HIT_MS = 30 * 60_000;
const MISS_MS = 60 * 60_000;
const ERROR_MS = 5 * 60_000;

function canManage(guild: Guild, member: { permissions: { has(flag: bigint): boolean } }, userId: string): boolean {
  if (guild.ownerId === userId) return true;
  return member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function remember(key: string, entry: MemoEntry): void {
  pruneMemo();
  memberMemo.set(key, entry);
  capMap(memberMemo, 20_000);
}

export function createNotificationDeps(client: Client, configManager: { getEffectiveConfig(guildId: string): Promise<{ plugins: Record<string, { enabled?: boolean } | undefined> }> }): NotificationDeps {
  let pluginNamesPromise: Promise<string[]> | null = null;
  return {
    pluginNames() {
      pluginNamesPromise ??= import("../plugins/availablePlugins.js").then(({ availablePlugins }) => availablePlugins.map((p) => p.name));
      return pluginNamesPromise;
    },
    botGuildIds() {
      return new Set(client.guilds.cache.keys());
    },
    guildsWithPlugin(plugin) {
      return cachedSwr(`notif-feature:${plugin}`, 5 * 60_000, 30 * 60_000, async () => {
        const out = new Set<string>();
        for (const guildId of client.guilds.cache.keys()) {
          const config = await configManager.getEffectiveConfig(guildId).catch(() => null);
          const section = config?.plugins[plugin];
          // A section that isn't there is a plugin that isn't on in this server.
          if (section && section.enabled !== false) out.add(guildId);
        }
        return out;
      });
    },
    async memberships(userId, guildIds, hints) {
      const out = new Map<string, Membership>();
      const hinted = new Map((hints ?? []).map((h) => [h.id, h.manager]));
      const lookups: Guild[] = [];
      const now = Date.now();
      for (const guildId of guildIds) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;
        if (guild.ownerId === userId) {
          out.set(guildId, { manager: true });
          continue;
        }
        const cachedMember = guild.members.cache.get(userId);
        if (cachedMember) {
          out.set(guildId, { manager: canManage(guild, cachedMember, userId) });
          continue;
        }
        if (hints) {
          // The user's own Discord server list is the answer for every server the bot hasn't cached.
          if (hinted.has(guildId)) out.set(guildId, { manager: hinted.get(guildId) === true });
          continue;
        }
        const memo = memberMemo.get(`${guildId}:${userId}`);
        if (memo && memo.until > now) {
          if (memo.member) out.set(guildId, { manager: memo.manager });
          continue;
        }
        lookups.push(guild);
      }
      const batch = lookups.slice(0, MAX_LOOKUPS_PER_FEED).filter(() => lookupLimiter.take("feed").ok);
      await Promise.all(
        batch.map(async (guild) => {
          const key = `${guild.id}:${userId}`;
          try {
            const member = await guild.members.fetch({ user: userId, cache: false });
            const manager = canManage(guild, member, userId);
            remember(key, { member: true, manager, until: Date.now() + HIT_MS });
            out.set(guild.id, { manager });
          } catch (error) {
            const code = (error as { code?: unknown }).code;
            remember(key, { member: false, manager: false, until: Date.now() + (code === 10007 ? MISS_MS : ERROR_MS) });
          }
        }),
      );
      return out;
    },
    memberCount(guildId) {
      return client.guilds.cache.get(guildId)?.memberCount ?? 0;
    },
  };
}
