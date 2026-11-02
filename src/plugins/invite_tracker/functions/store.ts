import { and, count, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { inviteBonus, inviteDailyStats, inviteJoins, inviteResets, inviteTrackedLinks } from "../../../db/schema.js";
import { EMPTY_COUNTS, type FakeReason, type InviteCounts, type JoinSource, type JoinStatus } from "./config.js";

/** `invite_resets.user_id` for a whole-server reset. */
export const GUILD_RESET_KEY = "*";

export type InviteJoin = typeof inviteJoins.$inferSelect;
export type TrackedLinkRow = typeof inviteTrackedLinks.$inferSelect;

// ── Count math ───────────────────────────────────────────────────────────────

/** regular − left − fake + bonus: the one total shown everywhere. */
export function inviteTotal(counts: Omit<InviteCounts, "total">): number {
  return counts.regular - counts.left - counts.fake + counts.bonus;
}

export function withTotal(counts: Omit<InviteCounts, "total">): InviteCounts {
  return { ...counts, total: inviteTotal(counts) };
}

export type InviterCounts = InviteCounts & { userId: string };

/**
 * Every inviter's counts in one pass: a single GROUP BY over the guild's join rows (CASE sums
 * per status, skipping joins before the inviter's latest reset cutoff, theirs or the server's)
 * with the bonus rows merged in. Sorted by total, then regular.
 */
export function computeGuildCounts(guildId: string): InviterCounts[] {
  const rows = getDb().all<{ user_id: string; regular: number; left_n: number; fake: number; bonus: number }>(sql`
    SELECT user_id, SUM(regular) AS regular, SUM(left_n) AS left_n, SUM(fake) AS fake, SUM(bonus) AS bonus FROM (
      SELECT j.inviter_id AS user_id,
        CASE WHEN j.status <> 'pending' THEN 1 ELSE 0 END AS regular,
        CASE WHEN j.status = 'valid' AND j.left_at IS NOT NULL THEN 1 ELSE 0 END AS left_n,
        CASE WHEN j.status = 'fake' THEN 1 ELSE 0 END AS fake,
        0 AS bonus
      FROM invite_joins j
      LEFT JOIN invite_resets ru ON ru.guild_id = j.guild_id AND ru.user_id = j.inviter_id
      LEFT JOIN invite_resets rg ON rg.guild_id = j.guild_id AND rg.user_id = ${GUILD_RESET_KEY}
      WHERE j.guild_id = ${guildId} AND j.inviter_id IS NOT NULL AND j.counted = 1
        AND j.joined_at > MAX(COALESCE(ru.reset_at, 0), COALESCE(rg.reset_at, 0))
      UNION ALL
      SELECT user_id, 0, 0, 0, amount FROM invite_bonus WHERE guild_id = ${guildId} AND amount <> 0
    ) GROUP BY user_id
  `);
  return rows
    .map((row) =>
      ({
        userId: row.user_id,
        ...withTotal({
          regular: Number(row.regular) || 0,
          left: Number(row.left_n) || 0,
          fake: Number(row.fake) || 0,
          bonus: Number(row.bonus) || 0,
        }),
      }) satisfies InviterCounts,
    )
    .filter((row) => row.regular > 0 || row.bonus !== 0)
    .sort((a, b) => b.total - a.total || b.regular - a.regular || a.userId.localeCompare(b.userId));
}

// Leaderboards and every join message read these, so each guild's counts are kept for a minute
// (at most 200 guilds, least recently used dropped first). Every write invalidates its guild.
const COUNTS_TTL_MS = 60_000;
const COUNTS_CACHE_MAX = 200;
const countsCache = new Map<string, { at: number; rows: InviterCounts[]; byUser: Map<string, InviterCounts> }>();

export function invalidateCounts(guildId: string): void {
  countsCache.delete(guildId);
}

export function getGuildCounts(guildId: string): { rows: InviterCounts[]; byUser: Map<string, InviterCounts> } {
  const now = Date.now();
  const cached = countsCache.get(guildId);
  if (cached && now - cached.at < COUNTS_TTL_MS) {
    countsCache.delete(guildId);
    countsCache.set(guildId, cached);
    return cached;
  }
  const rows = computeGuildCounts(guildId);
  const entry = { at: now, rows, byUser: new Map(rows.map((row) => [row.userId, row])) };
  countsCache.delete(guildId);
  countsCache.set(guildId, entry);
  while (countsCache.size > COUNTS_CACHE_MAX) countsCache.delete(countsCache.keys().next().value!);
  return entry;
}

export function getCounts(guildId: string, userId: string): InviteCounts {
  const row = getGuildCounts(guildId).byUser.get(userId);
  if (!row) return { ...EMPTY_COUNTS };
  const { userId: _ignored, ...counts } = row;
  return counts;
}

/** 1-based leaderboard rank, or null when they aren't on it. */
export function getRank(guildId: string, userId: string): number | null {
  const index = getGuildCounts(guildId).rows.findIndex((row) => row.userId === userId);
  return index === -1 ? null : index + 1;
}

/** Server-wide sums (every inviter's counts added up). */
export function guildTotals(guildId: string): InviteCounts {
  const sum = { regular: 0, left: 0, fake: 0, bonus: 0 };
  for (const row of getGuildCounts(guildId).rows) {
    sum.regular += row.regular;
    sum.left += row.left;
    sum.fake += row.fake;
    sum.bonus += row.bonus;
  }
  return withTotal(sum);
}

// ── Joins ────────────────────────────────────────────────────────────────────

export function insertJoin(values: {
  guildId: string;
  memberId: string;
  inviterId: string | null;
  code: string | null;
  source: JoinSource;
  trackedLinkId: number | null;
  joinedAt: Date;
  status: JoinStatus;
  fakeReason: FakeReason | null;
  counted: boolean;
  accountCreatedAt: Date;
}): InviteJoin {
  const row = getDb().insert(inviteJoins).values(values).returning().get();
  invalidateCounts(values.guildId);
  return row;
}

export function updateJoin(
  guildId: string,
  id: number,
  patch: Partial<Pick<InviteJoin, "status" | "fakeReason" | "leftAt">>,
): void {
  getDb().update(inviteJoins).set(patch).where(and(eq(inviteJoins.guildId, guildId), eq(inviteJoins.id, id))).run();
  invalidateCounts(guildId);
}

/**
 * Marks any of the member's joins still "in the server" as left: a leave the bot missed (it was
 * offline) shows up as an open row when the member joins again. Pending ones become unverified.
 */
export function closeStaleJoins(guildId: string, memberId: string, at: Date): void {
  const db = getDb();
  const where = and(eq(inviteJoins.guildId, guildId), eq(inviteJoins.memberId, memberId), isNull(inviteJoins.leftAt));
  db.update(inviteJoins)
    .set({ status: "fake", fakeReason: "unverified" })
    .where(and(where, eq(inviteJoins.status, "pending")))
    .run();
  const closed = db.update(inviteJoins).set({ leftAt: at }).where(where).returning({ id: inviteJoins.id }).all().length;
  if (closed > 0) invalidateCounts(guildId);
}

/** The member's most recent join that hasn't left yet. */
export function getOpenJoin(guildId: string, memberId: string): InviteJoin | null {
  return (
    getDb()
      .select()
      .from(inviteJoins)
      .where(and(eq(inviteJoins.guildId, guildId), eq(inviteJoins.memberId, memberId), isNull(inviteJoins.leftAt)))
      .orderBy(desc(inviteJoins.joinedAt), desc(inviteJoins.id))
      .limit(1)
      .get() ?? null
  );
}

export function getLatestJoin(guildId: string, memberId: string): InviteJoin | null {
  return (
    getDb()
      .select()
      .from(inviteJoins)
      .where(and(eq(inviteJoins.guildId, guildId), eq(inviteJoins.memberId, memberId)))
      .orderBy(desc(inviteJoins.joinedAt), desc(inviteJoins.id))
      .limit(1)
      .get() ?? null
  );
}

export function countMemberJoins(guildId: string, memberId: string): number {
  return (
    getDb()
      .select({ n: count() })
      .from(inviteJoins)
      .where(and(eq(inviteJoins.guildId, guildId), eq(inviteJoins.memberId, memberId)))
      .get()?.n ?? 0
  );
}

/** A member's own join history, newest first. */
export function listMemberJoins(guildId: string, memberId: string, limit = 20): InviteJoin[] {
  return getDb()
    .select()
    .from(inviteJoins)
    .where(and(eq(inviteJoins.guildId, guildId), eq(inviteJoins.memberId, memberId)))
    .orderBy(desc(inviteJoins.joinedAt), desc(inviteJoins.id))
    .limit(limit)
    .all();
}

/** The people someone invited, newest first, and how many there are in total. */
export function listInvitedBy(
  guildId: string,
  inviterId: string,
  limit = 100,
  offset = 0,
): { rows: InviteJoin[]; total: number } {
  const db = getDb();
  const where = and(eq(inviteJoins.guildId, guildId), eq(inviteJoins.inviterId, inviterId));
  const rows = db
    .select()
    .from(inviteJoins)
    .where(where)
    .orderBy(desc(inviteJoins.joinedAt), desc(inviteJoins.id))
    .limit(limit)
    .offset(offset)
    .all();
  const total = db.select({ n: count() }).from(inviteJoins).where(where).get()?.n ?? 0;
  return { rows, total };
}

export function listPendingGuilds(): string[] {
  return getDb()
    .selectDistinct({ guildId: inviteJoins.guildId })
    .from(inviteJoins)
    .where(eq(inviteJoins.status, "pending"))
    .all()
    .map((row) => row.guildId);
}

/** Pending joins that waited past the timeout become fake (unverified). Returns how many. */
export function expirePendingJoins(guildId: string, joinedBefore: Date): number {
  const changed = getDb()
    .update(inviteJoins)
    .set({ status: "fake", fakeReason: "unverified" })
    .where(and(eq(inviteJoins.guildId, guildId), eq(inviteJoins.status, "pending"), lt(inviteJoins.joinedAt, joinedBefore)))
    .returning({ id: inviteJoins.id })
    .all().length;
  if (changed > 0) invalidateCounts(guildId);
  return changed;
}

// ── Bonus & resets ───────────────────────────────────────────────────────────

/** Adds a (signed) bonus and returns the member's new net bonus. */
export function addBonus(guildId: string, userId: string, amount: number): number {
  const delta = Math.trunc(amount);
  const row = getDb()
    .insert(inviteBonus)
    .values({ guildId, userId, amount: delta, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [inviteBonus.guildId, inviteBonus.userId],
      set: { amount: sql`${inviteBonus.amount} + ${delta}`, updatedAt: new Date() },
    })
    .returning({ amount: inviteBonus.amount })
    .get();
  invalidateCounts(guildId);
  return row?.amount ?? delta;
}

/** Soft reset: joins before now stop counting for them, and their bonus is cleared. History stays. */
export function resetMemberCounts(guildId: string, userId: string, at = new Date()): void {
  const db = getDb();
  db.transaction((tx) => {
    tx.insert(inviteResets)
      .values({ guildId, userId, resetAt: at })
      .onConflictDoUpdate({ target: [inviteResets.guildId, inviteResets.userId], set: { resetAt: at } })
      .run();
    tx.delete(inviteBonus).where(and(eq(inviteBonus.guildId, guildId), eq(inviteBonus.userId, userId))).run();
  });
  invalidateCounts(guildId);
}

/** Soft reset for everyone in the server. */
export function resetGuildCounts(guildId: string, at = new Date()): void {
  resetMemberCounts(guildId, GUILD_RESET_KEY, at);
  getDb().delete(inviteBonus).where(eq(inviteBonus.guildId, guildId)).run();
  invalidateCounts(guildId);
}

// ── Tracked links ────────────────────────────────────────────────────────────

export function parseRoleIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function insertTrackedLink(values: {
  guildId: string;
  code: string;
  name: string;
  channelId: string;
  roleIds: string[];
  maxUses: number;
  maxAge: number;
  createdBy: string | null;
}): TrackedLinkRow {
  return getDb()
    .insert(inviteTrackedLinks)
    .values({ ...values, roleIds: JSON.stringify(values.roleIds), createdAt: new Date() })
    .returning()
    .get();
}

export function listTrackedLinks(guildId: string, options: { includeDeleted?: boolean } = {}): TrackedLinkRow[] {
  return getDb()
    .select()
    .from(inviteTrackedLinks)
    .where(
      options.includeDeleted
        ? eq(inviteTrackedLinks.guildId, guildId)
        : and(eq(inviteTrackedLinks.guildId, guildId), isNull(inviteTrackedLinks.deletedAt)),
    )
    .orderBy(desc(inviteTrackedLinks.createdAt), desc(inviteTrackedLinks.id))
    .all();
}

export function countActiveLinks(guildId: string): number {
  return (
    getDb()
      .select({ n: count() })
      .from(inviteTrackedLinks)
      .where(and(eq(inviteTrackedLinks.guildId, guildId), isNull(inviteTrackedLinks.deletedAt)))
      .get()?.n ?? 0
  );
}

export function getTrackedLink(guildId: string, id: number): TrackedLinkRow | null {
  return (
    getDb()
      .select()
      .from(inviteTrackedLinks)
      .where(and(eq(inviteTrackedLinks.guildId, guildId), eq(inviteTrackedLinks.id, id)))
      .get() ?? null
  );
}

export function getTrackedLinksById(guildId: string, ids: number[]): Map<number, TrackedLinkRow> {
  if (ids.length === 0) return new Map();
  const rows = getDb()
    .select()
    .from(inviteTrackedLinks)
    .where(and(eq(inviteTrackedLinks.guildId, guildId), inArray(inviteTrackedLinks.id, ids)))
    .all();
  return new Map(rows.map((row) => [row.id, row]));
}

/** Live (not deleted) tracked-link codes for a guild, for attribution. */
export function activeTrackedCodes(guildId: string): Map<string, TrackedLinkRow> {
  return new Map(listTrackedLinks(guildId).map((row) => [row.code, row]));
}

export function softDeleteTrackedLink(guildId: string, id: number): boolean {
  return (
    getDb()
      .update(inviteTrackedLinks)
      .set({ deletedAt: new Date() })
      .where(and(eq(inviteTrackedLinks.guildId, guildId), eq(inviteTrackedLinks.id, id), isNull(inviteTrackedLinks.deletedAt)))
      .returning({ id: inviteTrackedLinks.id })
      .all().length > 0
  );
}

export type LinkStats = { joins: number; stayed: number; left: number; fake: number };

/**
 * Joins per tracked link, from the raw rows plus whatever retention has folded into daily stats.
 * `stayed` = valid joins still in the server, `left` = valid joins that left.
 */
export function trackedLinkStats(guildId: string, since?: Date): Map<number, LinkStats> {
  const db = getDb();
  const sinceMs = since?.getTime() ?? 0;
  const raw = db.all<{ link: number; joins: number; stayed: number; left_n: number; fake: number }>(sql`
    SELECT tracked_link_id AS link, COUNT(*) AS joins,
      SUM(CASE WHEN status = 'valid' AND left_at IS NULL THEN 1 ELSE 0 END) AS stayed,
      SUM(CASE WHEN status = 'valid' AND left_at IS NOT NULL THEN 1 ELSE 0 END) AS left_n,
      SUM(CASE WHEN status = 'fake' THEN 1 ELSE 0 END) AS fake
    FROM invite_joins
    WHERE guild_id = ${guildId} AND tracked_link_id IS NOT NULL AND joined_at >= ${sinceMs}
    GROUP BY tracked_link_id
  `);
  const sinceDay = since ? since.toISOString().slice(0, 10) : "0000-00-00";
  const folded = db.all<{ link: number; joins: number; leaves: number; fakes: number }>(sql`
    SELECT tracked_link_id AS link, SUM(joins) AS joins, SUM(leaves) AS leaves, SUM(fakes) AS fakes
    FROM invite_daily_stats
    WHERE guild_id = ${guildId} AND tracked_link_id <> 0 AND day >= ${sinceDay}
    GROUP BY tracked_link_id
  `);
  const stats = new Map<number, LinkStats>();
  for (const row of raw) {
    stats.set(Number(row.link), {
      joins: Number(row.joins) || 0,
      stayed: Number(row.stayed) || 0,
      left: Number(row.left_n) || 0,
      fake: Number(row.fake) || 0,
    });
  }
  for (const row of folded) {
    const entry = stats.get(Number(row.link)) ?? { joins: 0, stayed: 0, left: 0, fake: 0 };
    const joins = Number(row.joins) || 0;
    const leaves = Number(row.leaves) || 0;
    const fakes = Number(row.fakes) || 0;
    entry.joins += joins;
    entry.left += leaves;
    entry.fake += fakes;
    entry.stayed += Math.max(0, joins - leaves - fakes);
    stats.set(Number(row.link), entry);
  }
  return stats;
}

// ── Retention ────────────────────────────────────────────────────────────────

export function listGuildsWithJoins(): string[] {
  return getDb()
    .selectDistinct({ guildId: inviteJoins.guildId })
    .from(inviteJoins)
    .all()
    .map((row) => row.guildId);
}

/**
 * Folds join rows older than `cutoff` into per-day totals (by join day, source and tracked link)
 * and deletes them, in one transaction. Returns how many rows were folded.
 */
export function foldOldJoins(guildId: string, cutoff: Date): number {
  const cutoffMs = cutoff.getTime();
  const db = getDb();
  let folded = 0;
  db.transaction((tx) => {
    const groups = tx.all<{ day: string; source: string; link: number; joins: number; leaves: number; fakes: number }>(sql`
      SELECT strftime('%Y-%m-%d', joined_at / 1000, 'unixepoch') AS day, source, COALESCE(tracked_link_id, 0) AS link,
        COUNT(*) AS joins,
        SUM(CASE WHEN left_at IS NOT NULL THEN 1 ELSE 0 END) AS leaves,
        SUM(CASE WHEN status = 'fake' THEN 1 ELSE 0 END) AS fakes
      FROM invite_joins
      WHERE guild_id = ${guildId} AND joined_at < ${cutoffMs}
      GROUP BY day, source, link
    `);
    for (const group of groups) {
      const joins = Number(group.joins) || 0;
      const leaves = Number(group.leaves) || 0;
      const fakes = Number(group.fakes) || 0;
      folded += joins;
      tx.insert(inviteDailyStats)
        .values({ guildId, day: group.day, source: group.source, trackedLinkId: Number(group.link) || 0, joins, leaves, fakes })
        .onConflictDoUpdate({
          target: [inviteDailyStats.guildId, inviteDailyStats.day, inviteDailyStats.source, inviteDailyStats.trackedLinkId],
          set: {
            joins: sql`${inviteDailyStats.joins} + ${joins}`,
            leaves: sql`${inviteDailyStats.leaves} + ${leaves}`,
            fakes: sql`${inviteDailyStats.fakes} + ${fakes}`,
          },
        })
        .run();
    }
    if (groups.length > 0) {
      tx.delete(inviteJoins).where(and(eq(inviteJoins.guildId, guildId), lt(inviteJoins.joinedAt, cutoff))).run();
    }
  });
  if (folded > 0) invalidateCounts(guildId);
  return folded;
}

// ── Personal data ────────────────────────────────────────────────────────────

export function countUserInviteData(userId: string): number {
  const db = getDb();
  const joins = db.select({ n: count() }).from(inviteJoins).where(eq(inviteJoins.memberId, userId)).get()?.n ?? 0;
  const bonus = db.select({ n: count() }).from(inviteBonus).where(eq(inviteBonus.userId, userId)).get()?.n ?? 0;
  const resets = db.select({ n: count() }).from(inviteResets).where(eq(inviteResets.userId, userId)).get()?.n ?? 0;
  return joins + bonus + resets;
}

export function exportUserInviteData(userId: string) {
  const db = getDb();
  return {
    joins: db.select().from(inviteJoins).where(eq(inviteJoins.memberId, userId)).all(),
    invited: db.select().from(inviteJoins).where(eq(inviteJoins.inviterId, userId)).all(),
    bonus: db.select().from(inviteBonus).where(eq(inviteBonus.userId, userId)).all(),
    resets: db.select().from(inviteResets).where(eq(inviteResets.userId, userId)).all(),
    trackedLinks: db.select().from(inviteTrackedLinks).where(eq(inviteTrackedLinks.createdBy, userId)).all(),
  };
}

/**
 * Erases a user: their own join rows, bonus and reset rows go; joins they invited stay (they're
 * the other member's history) with the inviter blanked, and tracked links they made lose the
 * creator. Returns how many rows were deleted or blanked.
 */
export function deleteUserInviteData(userId: string): number {
  const db = getDb();
  let changed = 0;
  db.transaction((tx) => {
    changed += tx.delete(inviteJoins).where(eq(inviteJoins.memberId, userId)).returning({ id: inviteJoins.id }).all().length;
    changed += tx
      .update(inviteJoins)
      .set({ inviterId: null })
      .where(eq(inviteJoins.inviterId, userId))
      .returning({ id: inviteJoins.id })
      .all().length;
    changed += tx.delete(inviteBonus).where(eq(inviteBonus.userId, userId)).returning({ g: inviteBonus.guildId }).all().length;
    changed += tx.delete(inviteResets).where(eq(inviteResets.userId, userId)).returning({ g: inviteResets.guildId }).all().length;
    changed += tx
      .update(inviteTrackedLinks)
      .set({ createdBy: null })
      .where(eq(inviteTrackedLinks.createdBy, userId))
      .returning({ id: inviteTrackedLinks.id })
      .all().length;
  });
  countsCache.clear();
  return changed;
}
