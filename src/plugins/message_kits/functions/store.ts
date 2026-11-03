import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { messageKitAssets, messageKitPosts, messageKits, messageKitSchedules, messageKitVersions } from "../../../db/schema.js";
import { KIT_LIMITS } from "./constants.js";

export type KitRecord = typeof messageKits.$inferSelect;
export type KitVersionRecord = typeof messageKitVersions.$inferSelect;
export type KitPostRecord = typeof messageKitPosts.$inferSelect;
export type KitScheduleRecord = typeof messageKitSchedules.$inferSelect;
export type KitAssetRecord = typeof messageKitAssets.$inferSelect;

// ── Kits ─────────────────────────────────────────────────────────────────────

export function listKits(guildId: string): KitRecord[] {
  return getDb().select().from(messageKits).where(eq(messageKits.guildId, guildId)).orderBy(desc(messageKits.updatedAt)).all();
}

export function countKits(guildId: string): number {
  return getDb().select({ total: count() }).from(messageKits).where(eq(messageKits.guildId, guildId)).get()?.total ?? 0;
}

export function getKit(guildId: string, kitId: number): KitRecord | null {
  if (!Number.isSafeInteger(kitId)) return null;
  return getDb().select().from(messageKits).where(and(eq(messageKits.guildId, guildId), eq(messageKits.id, kitId))).get() ?? null;
}

/** A kit by id in any server: only for buttons on test sends in DMs, which have no server. */
export function getKitById(kitId: number): KitRecord | null {
  if (!Number.isSafeInteger(kitId)) return null;
  return getDb().select().from(messageKits).where(eq(messageKits.id, kitId)).get() ?? null;
}

/** A copy's channel (or thread) was deleted: every copy in it is gone. */
export function markChannelPostsDeleted(guildId: string, channelId: string): number {
  return getDb()
    .update(messageKitPosts)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(messageKitPosts.guildId, guildId),
        isNull(messageKitPosts.deletedAt),
        or(eq(messageKitPosts.channelId, channelId), eq(messageKitPosts.threadId, channelId)),
      ),
    )
    .run().changes;
}

export function kitNamesById(guildId: string, ids: number[]): Map<number, string> {
  const unique = [...new Set(ids)].filter(Number.isSafeInteger);
  if (!unique.length) return new Map();
  const rows = getDb()
    .select({ id: messageKits.id, name: messageKits.name })
    .from(messageKits)
    .where(and(eq(messageKits.guildId, guildId), inArray(messageKits.id, unique)))
    .all();
  return new Map(rows.map((row) => [row.id, row.name]));
}

export function insertKit(input: Omit<KitRecord, "id" | "version" | "archived"> & { note?: string }): KitRecord {
  const db = getDb();
  return db.transaction((tx) => {
    const { note, ...values } = input;
    const kit = tx.insert(messageKits).values({ ...values, version: 1, archived: false }).returning().get();
    tx.insert(messageKitVersions)
      .values({ kitId: kit.id, version: 1, document: kit.document, savedBy: kit.createdBy, savedAt: kit.createdAt, note: note ?? "" })
      .run();
    return kit;
  });
}

/**
 * Updates a kit. A new `document` bumps the version and records it (keeping the newest 25).
 */
export function updateKit(
  kit: KitRecord,
  patch: Partial<Pick<KitRecord, "name" | "folder" | "description" | "archived">> & { document?: string; note?: string },
  userId: string,
): KitRecord {
  const now = new Date();
  const db = getDb();
  return db.transaction((tx) => {
    const { document, note, ...rest } = patch;
    const changedDocument = document !== undefined && document !== kit.document;
    const version = changedDocument ? kit.version + 1 : kit.version;
    const values = { ...rest, ...(changedDocument ? { document, version } : {}), updatedBy: userId, updatedAt: now };
    const updated = tx.update(messageKits).set(values).where(eq(messageKits.id, kit.id)).returning().get();
    if (changedDocument) {
      tx.insert(messageKitVersions)
        .values({ kitId: kit.id, version, document: document!, savedBy: userId, savedAt: now, note: (note ?? "").slice(0, 200) })
        .onConflictDoNothing()
        .run();
      tx.delete(messageKitVersions)
        .where(and(eq(messageKitVersions.kitId, kit.id), lte(messageKitVersions.version, version - KIT_LIMITS.versionsPerKit)))
        .run();
    }
    return updated;
  });
}

/** Removes a kit with its versions and schedules. Its posts stay as detached history. */
export function deleteKitRecord(guildId: string, kitId: number): void {
  getDb().transaction((tx) => {
    tx.delete(messageKitVersions).where(eq(messageKitVersions.kitId, kitId)).run();
    tx.delete(messageKitSchedules).where(and(eq(messageKitSchedules.guildId, guildId), eq(messageKitSchedules.kitId, kitId))).run();
    tx.update(messageKitPosts).set({ kitId: null }).where(and(eq(messageKitPosts.guildId, guildId), eq(messageKitPosts.kitId, kitId))).run();
    tx.delete(messageKits).where(and(eq(messageKits.guildId, guildId), eq(messageKits.id, kitId))).run();
  });
}

export function listVersions(kitId: number): KitVersionRecord[] {
  return getDb().select().from(messageKitVersions).where(eq(messageKitVersions.kitId, kitId)).orderBy(desc(messageKitVersions.version)).all();
}

export function getVersion(kitId: number, version: number): KitVersionRecord | null {
  if (!Number.isSafeInteger(version)) return null;
  return (
    getDb()
      .select()
      .from(messageKitVersions)
      .where(and(eq(messageKitVersions.kitId, kitId), eq(messageKitVersions.version, version)))
      .get() ?? null
  );
}

// ── Posts ────────────────────────────────────────────────────────────────────

export function insertPost(values: Omit<KitPostRecord, "id">): KitPostRecord {
  return getDb().insert(messageKitPosts).values(values).returning().get();
}

export function getPost(guildId: string, postId: number): KitPostRecord | null {
  if (!Number.isSafeInteger(postId)) return null;
  return getDb().select().from(messageKitPosts).where(and(eq(messageKitPosts.guildId, guildId), eq(messageKitPosts.id, postId))).get() ?? null;
}

export function getPostByMessage(messageId: string): KitPostRecord | null {
  return getDb().select().from(messageKitPosts).where(eq(messageKitPosts.messageId, messageId)).get() ?? null;
}

export function updatePost(postId: number, patch: Partial<Omit<KitPostRecord, "id" | "guildId">>): KitPostRecord | null {
  return getDb().update(messageKitPosts).set(patch).where(eq(messageKitPosts.id, postId)).returning().get() ?? null;
}

export function deletePostRow(postId: number): void {
  getDb().delete(messageKitPosts).where(eq(messageKitPosts.id, postId)).run();
}

/** Live copies of a kit, newest first. */
export function listLivePosts(guildId: string, kitId: number): KitPostRecord[] {
  return getDb()
    .select()
    .from(messageKitPosts)
    .where(and(eq(messageKitPosts.guildId, guildId), eq(messageKitPosts.kitId, kitId), isNull(messageKitPosts.deletedAt)))
    .orderBy(desc(messageKitPosts.postedAt))
    .all();
}

export function listRecentPosts(guildId: string, kitId: number, limit = 100): KitPostRecord[] {
  return getDb()
    .select()
    .from(messageKitPosts)
    .where(and(eq(messageKitPosts.guildId, guildId), eq(messageKitPosts.kitId, kitId)))
    .orderBy(desc(messageKitPosts.postedAt))
    .limit(limit)
    .all();
}

export function pagePosts(guildId: string, kitId: number | null, page: number, pageSize: number): { rows: KitPostRecord[]; total: number } {
  const where = kitId === null ? eq(messageKitPosts.guildId, guildId) : and(eq(messageKitPosts.guildId, guildId), eq(messageKitPosts.kitId, kitId));
  const db = getDb();
  const total = db.select({ total: count() }).from(messageKitPosts).where(where).get()?.total ?? 0;
  const rows = db
    .select()
    .from(messageKitPosts)
    .where(where)
    .orderBy(desc(messageKitPosts.postedAt), desc(messageKitPosts.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();
  return { rows, total };
}

/** Per kit: live copies, and how many were sent from an older version. */
export function postCountsByKit(guildId: string): Map<number, { live: number; outOfDate: number }> {
  const rows = getDb()
    .select({
      kitId: messageKitPosts.kitId,
      live: count(),
      outOfDate: sql<number>`sum(case when ${messageKitPosts.kitVersion} < ${messageKits.version} then 1 else 0 end)`,
    })
    .from(messageKitPosts)
    .innerJoin(messageKits, eq(messageKits.id, messageKitPosts.kitId))
    .where(and(eq(messageKitPosts.guildId, guildId), isNotNull(messageKitPosts.kitId), isNull(messageKitPosts.deletedAt)))
    .groupBy(messageKitPosts.kitId)
    .all();
  return new Map(rows.map((row) => [row.kitId!, { live: row.live, outOfDate: Number(row.outOfDate ?? 0) }]));
}

/** Forgets copies deleted before `cutoff`. */
export function pruneDeletedPosts(cutoff: Date): number {
  return getDb().delete(messageKitPosts).where(and(isNotNull(messageKitPosts.deletedAt), lt(messageKitPosts.deletedAt, cutoff))).run().changes;
}

// ── Schedules ────────────────────────────────────────────────────────────────

export function listSchedules(guildId: string, kitId?: number): KitScheduleRecord[] {
  const where = kitId === undefined ? eq(messageKitSchedules.guildId, guildId) : and(eq(messageKitSchedules.guildId, guildId), eq(messageKitSchedules.kitId, kitId));
  return getDb().select().from(messageKitSchedules).where(where).orderBy(asc(messageKitSchedules.id)).all();
}

export function countSchedules(guildId: string): number {
  return getDb().select({ total: count() }).from(messageKitSchedules).where(eq(messageKitSchedules.guildId, guildId)).get()?.total ?? 0;
}

export function getSchedule(guildId: string, id: number): KitScheduleRecord | null {
  if (!Number.isSafeInteger(id)) return null;
  return getDb().select().from(messageKitSchedules).where(and(eq(messageKitSchedules.guildId, guildId), eq(messageKitSchedules.id, id))).get() ?? null;
}

export function insertSchedule(values: Omit<KitScheduleRecord, "id">): KitScheduleRecord {
  return getDb().insert(messageKitSchedules).values(values).returning().get();
}

export function updateSchedule(id: number, patch: Partial<Omit<KitScheduleRecord, "id" | "guildId">>): KitScheduleRecord | null {
  return getDb().update(messageKitSchedules).set(patch).where(eq(messageKitSchedules.id, id)).returning().get() ?? null;
}

export function deleteSchedule(guildId: string, id: number): boolean {
  return getDb().delete(messageKitSchedules).where(and(eq(messageKitSchedules.guildId, guildId), eq(messageKitSchedules.id, id))).run().changes > 0;
}

export function dueSchedules(now: Date, limit: number): KitScheduleRecord[] {
  return getDb()
    .select()
    .from(messageKitSchedules)
    .where(and(eq(messageKitSchedules.enabled, true), isNotNull(messageKitSchedules.nextRunAt), lte(messageKitSchedules.nextRunAt, now)))
    .orderBy(asc(messageKitSchedules.nextRunAt))
    .limit(limit)
    .all();
}

export function scheduleCountsByKit(guildId: string): Map<number, number> {
  const rows = getDb()
    .select({ kitId: messageKitSchedules.kitId, total: count() })
    .from(messageKitSchedules)
    .where(and(eq(messageKitSchedules.guildId, guildId), eq(messageKitSchedules.enabled, true)))
    .groupBy(messageKitSchedules.kitId)
    .all();
  return new Map(rows.map((row) => [row.kitId, row.total]));
}

// ── Assets ───────────────────────────────────────────────────────────────────

export function listAssets(guildId: string): KitAssetRecord[] {
  return getDb().select().from(messageKitAssets).where(eq(messageKitAssets.guildId, guildId)).orderBy(desc(messageKitAssets.createdAt)).all();
}

export function getAssets(guildId: string, ids: string[]): KitAssetRecord[] {
  if (!ids.length) return [];
  return getDb()
    .select()
    .from(messageKitAssets)
    .where(and(eq(messageKitAssets.guildId, guildId), inArray(messageKitAssets.id, ids)))
    .all();
}

export function getAsset(guildId: string, id: string): KitAssetRecord | null {
  return getDb().select().from(messageKitAssets).where(and(eq(messageKitAssets.guildId, guildId), eq(messageKitAssets.id, id))).get() ?? null;
}

export function assetUsage(guildId: string): { count: number; bytes: number } {
  const row = getDb()
    .select({ count: count(), bytes: sql<number>`coalesce(sum(${messageKitAssets.size}), 0)` })
    .from(messageKitAssets)
    .where(eq(messageKitAssets.guildId, guildId))
    .get();
  return { count: row?.count ?? 0, bytes: Number(row?.bytes ?? 0) };
}

export function insertAsset(values: KitAssetRecord): KitAssetRecord {
  return getDb().insert(messageKitAssets).values(values).returning().get();
}

export function deleteAssetRow(guildId: string, id: string): boolean {
  return getDb().delete(messageKitAssets).where(and(eq(messageKitAssets.guildId, guildId), eq(messageKitAssets.id, id))).run().changes > 0;
}

// ── Personal data ────────────────────────────────────────────────────────────

/** What names a person: kits, versions, sent copies, schedules and uploads they made. The
 *  messages themselves belong to the server, so only the authorship is personal. */
export function exportUserKitData(userId: string) {
  const db = getDb();
  return {
    kits: db
      .select({ guildId: messageKits.guildId, id: messageKits.id, name: messageKits.name, createdAt: messageKits.createdAt, updatedAt: messageKits.updatedAt })
      .from(messageKits)
      .where(or(eq(messageKits.createdBy, userId), eq(messageKits.updatedBy, userId)))
      .all(),
    versions: db
      .select({ kitId: messageKitVersions.kitId, version: messageKitVersions.version, savedAt: messageKitVersions.savedAt, note: messageKitVersions.note })
      .from(messageKitVersions)
      .where(eq(messageKitVersions.savedBy, userId))
      .all(),
    posts: db
      .select({ guildId: messageKitPosts.guildId, kitId: messageKitPosts.kitId, channelId: messageKitPosts.channelId, messageId: messageKitPosts.messageId, postedAt: messageKitPosts.postedAt })
      .from(messageKitPosts)
      .where(eq(messageKitPosts.postedBy, userId))
      .all(),
    schedules: db
      .select({ guildId: messageKitSchedules.guildId, kitId: messageKitSchedules.kitId, channelId: messageKitSchedules.channelId, createdAt: messageKitSchedules.createdAt })
      .from(messageKitSchedules)
      .where(eq(messageKitSchedules.createdBy, userId))
      .all(),
    assets: db
      .select({ guildId: messageKitAssets.guildId, id: messageKitAssets.id, filename: messageKitAssets.filename, createdAt: messageKitAssets.createdAt })
      .from(messageKitAssets)
      .where(eq(messageKitAssets.createdBy, userId))
      .all(),
  };
}

export function countUserKitData(userId: string): number {
  return Object.values(exportUserKitData(userId)).reduce((sum, rows) => sum + rows.length, 0);
}

/** Removes the person's name from everything they made (the server's kits and messages stay). */
export function deleteUserKitData(userId: string): number {
  let changed = 0;
  getDb().transaction((tx) => {
    changed += tx.update(messageKits).set({ createdBy: null }).where(eq(messageKits.createdBy, userId)).run().changes;
    changed += tx.update(messageKits).set({ updatedBy: null }).where(eq(messageKits.updatedBy, userId)).run().changes;
    changed += tx.update(messageKitVersions).set({ savedBy: null }).where(eq(messageKitVersions.savedBy, userId)).run().changes;
    changed += tx.update(messageKitPosts).set({ postedBy: null }).where(eq(messageKitPosts.postedBy, userId)).run().changes;
    changed += tx.update(messageKitSchedules).set({ createdBy: null }).where(eq(messageKitSchedules.createdBy, userId)).run().changes;
    changed += tx.update(messageKitAssets).set({ createdBy: null }).where(eq(messageKitAssets.createdBy, userId)).run().changes;
  });
  return changed;
}
