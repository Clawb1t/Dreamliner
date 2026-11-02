import { and, count, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import {
  teamActions,
  teamActivityDaily,
  teamFeedback,
  teamInactivityAlerts,
  teamLeave,
  teamMembers,
  teamNotes,
  teamOnboarding,
  teamReports,
  teamRosterMessages,
  teamShifts,
} from "../../../db/schema.js";
import type { LeaveKind, LeaveStatus, MemberStatus, TeamActionType } from "./config.js";

export type TeamMemberRecord = typeof teamMembers.$inferSelect;
export type ShiftRow = typeof teamShifts.$inferSelect;
export type LeaveRow = typeof teamLeave.$inferSelect;
export type ActionRow = typeof teamActions.$inferSelect;
export type NoteRow = typeof teamNotes.$inferSelect;
export type FeedbackRow = typeof teamFeedback.$inferSelect;
export type OnboardingRow = typeof teamOnboarding.$inferSelect;

export type Page<T> = { rows: T[]; total: number };

// ── Members ──────────────────────────────────────────────────────────────────

export function getTeamMember(guildId: string, userId: string): TeamMemberRecord | null {
  return (
    getDb()
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.guildId, guildId), eq(teamMembers.userId, userId)))
      .get() ?? null
  );
}

/** Everyone currently on the team, including suspended members (left and terminated excluded). */
export function listCurrentTeam(guildId: string): TeamMemberRecord[] {
  return getDb()
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.guildId, guildId), isNull(teamMembers.leftTeamAt), ne(teamMembers.status, "terminated")))
    .all();
}

export function upsertTeamMember(guildId: string, userId: string, patch: Partial<Omit<TeamMemberRecord, "guildId" | "userId">>): TeamMemberRecord {
  const now = new Date();
  const existing = getTeamMember(guildId, userId);
  if (existing) {
    getDb()
      .update(teamMembers)
      .set({ ...patch, updatedAt: now })
      .where(and(eq(teamMembers.guildId, guildId), eq(teamMembers.userId, userId)))
      .run();
    return { ...existing, ...patch, updatedAt: now };
  }
  const row: TeamMemberRecord = {
    guildId,
    userId,
    joinedAt: now,
    leftTeamAt: null,
    status: "active",
    rankId: null,
    suspendedUntil: null,
    suspendedRoleIds: "[]",
    trialEndsAt: null,
    trialReviewedAt: null,
    updatedAt: now,
    ...patch,
  };
  getDb().insert(teamMembers).values(row).run();
  return row;
}

export function setMemberStatus(guildId: string, userId: string, status: MemberStatus, extra: Partial<TeamMemberRecord> = {}): void {
  upsertTeamMember(guildId, userId, { status, ...extra });
}

export function dueSuspensions(now = new Date()): TeamMemberRecord[] {
  return getDb()
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.status, "suspended"), lte(teamMembers.suspendedUntil, now)))
    .all();
}

export function dueTrials(now = new Date()): TeamMemberRecord[] {
  return getDb()
    .select()
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.status, "active"),
        isNull(teamMembers.leftTeamAt),
        isNull(teamMembers.trialReviewedAt),
        lte(teamMembers.trialEndsAt, now),
      ),
    )
    .all();
}

export function parseRoleIds(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

// ── Shifts ───────────────────────────────────────────────────────────────────

export function getShift(guildId: string, id: number): ShiftRow | null {
  return getDb().select().from(teamShifts).where(and(eq(teamShifts.guildId, guildId), eq(teamShifts.id, id))).get() ?? null;
}

export function getActiveShift(guildId: string, userId: string): ShiftRow | null {
  return (
    getDb()
      .select()
      .from(teamShifts)
      .where(and(eq(teamShifts.guildId, guildId), eq(teamShifts.userId, userId), eq(teamShifts.status, "active")))
      .get() ?? null
  );
}

export function listActiveShifts(guildId: string): ShiftRow[] {
  return getDb()
    .select()
    .from(teamShifts)
    .where(and(eq(teamShifts.guildId, guildId), eq(teamShifts.status, "active")))
    .orderBy(teamShifts.startedAt)
    .all();
}

/** Every active shift on every server (the tick checks them for auto clock-out). */
export function listAllActiveShifts(): ShiftRow[] {
  return getDb().select().from(teamShifts).where(eq(teamShifts.status, "active")).all();
}

export function countActiveShifts(guildId: string): number {
  return (
    getDb()
      .select({ n: count() })
      .from(teamShifts)
      .where(and(eq(teamShifts.guildId, guildId), eq(teamShifts.status, "active")))
      .get()?.n ?? 0
  );
}

export function insertShift(row: Omit<typeof teamShifts.$inferInsert, "id">): ShiftRow {
  return getDb().insert(teamShifts).values(row).returning().get();
}

export function updateShift(guildId: string, id: number, patch: Partial<Omit<ShiftRow, "id" | "guildId">>): ShiftRow | null {
  return (
    getDb()
      .update(teamShifts)
      .set(patch)
      .where(and(eq(teamShifts.guildId, guildId), eq(teamShifts.id, id)))
      .returning()
      .get() ?? null
  );
}

/** Shifts that count (active or ended) and overlap [from, to), optionally for some members. */
export function shiftsOverlapping(guildId: string, from: Date, to: Date, userIds?: string[]): ShiftRow[] {
  if (userIds && userIds.length === 0) return [];
  const conditions: SQL[] = [
    eq(teamShifts.guildId, guildId),
    inArray(teamShifts.status, ["active", "ended"]),
    lt(teamShifts.startedAt, to),
    or(isNull(teamShifts.endedAt), gte(teamShifts.endedAt, from))!,
  ];
  if (userIds) conditions.push(inArray(teamShifts.userId, userIds));
  return getDb().select().from(teamShifts).where(and(...conditions)).all();
}

export function listShifts(
  guildId: string,
  filter: { status?: string | null; userId?: string | null; since?: Date | null },
  limit: number,
  offset: number,
): Page<ShiftRow> {
  const conditions: SQL[] = [eq(teamShifts.guildId, guildId)];
  if (filter.status) conditions.push(eq(teamShifts.status, filter.status));
  if (filter.userId) conditions.push(eq(teamShifts.userId, filter.userId));
  if (filter.since) conditions.push(gte(teamShifts.startedAt, filter.since));
  const where = and(...conditions);
  const db = getDb();
  const rows = db.select().from(teamShifts).where(where).orderBy(desc(teamShifts.startedAt)).limit(limit).offset(offset).all();
  const total = db.select({ n: count() }).from(teamShifts).where(where).get()?.n ?? 0;
  return { rows, total };
}

export function lastShiftAt(guildId: string): Map<string, number> {
  const rows = getDb().all<{ user_id: string; last: number }>(sql`
    SELECT user_id, MAX(COALESCE(ended_at, started_at)) AS last FROM team_shifts
    WHERE guild_id = ${guildId} AND status <> 'voided' GROUP BY user_id
  `);
  return new Map(rows.map((row) => [row.user_id, Number(row.last)]));
}

// ── Leave ────────────────────────────────────────────────────────────────────

export function getLeave(guildId: string, id: number): LeaveRow | null {
  return getDb().select().from(teamLeave).where(and(eq(teamLeave.guildId, guildId), eq(teamLeave.id, id))).get() ?? null;
}

export function insertLeave(row: Omit<typeof teamLeave.$inferInsert, "id">): LeaveRow {
  return getDb().insert(teamLeave).values(row).returning().get();
}

export function updateLeave(guildId: string, id: number, patch: Partial<Omit<LeaveRow, "id" | "guildId">>): LeaveRow | null {
  return (
    getDb()
      .update(teamLeave)
      .set(patch)
      .where(and(eq(teamLeave.guildId, guildId), eq(teamLeave.id, id)))
      .returning()
      .get() ?? null
  );
}

/** The member's pending, approved or active request, if any (at most one is allowed). */
export function getOpenLeave(guildId: string, userId: string): LeaveRow | null {
  return (
    getDb()
      .select()
      .from(teamLeave)
      .where(and(eq(teamLeave.guildId, guildId), eq(teamLeave.userId, userId), inArray(teamLeave.status, ["pending", "approved", "active"])))
      .orderBy(desc(teamLeave.createdAt))
      .get() ?? null
  );
}

export function lastLeaveDecision(guildId: string, userId: string): Date | null {
  const row = getDb()
    .select({ at: sql<number | null>`MAX(COALESCE(${teamLeave.endedAt}, ${teamLeave.decidedAt}))` })
    .from(teamLeave)
    .where(and(eq(teamLeave.guildId, guildId), eq(teamLeave.userId, userId), inArray(teamLeave.status, ["approved", "denied", "active", "ended"])))
    .get();
  return row?.at ? new Date(Number(row.at)) : null;
}

export function listLeaveByStatus(guildId: string, statuses: LeaveStatus[], limit = 50, offset = 0, since?: Date | null): Page<LeaveRow> {
  const conditions: SQL[] = [eq(teamLeave.guildId, guildId), inArray(teamLeave.status, statuses)];
  if (since) conditions.push(gte(teamLeave.createdAt, since));
  const where = and(...conditions);
  const db = getDb();
  const rows = db.select().from(teamLeave).where(where).orderBy(desc(teamLeave.createdAt)).limit(limit).offset(offset).all();
  const total = db.select({ n: count() }).from(teamLeave).where(where).get()?.n ?? 0;
  return { rows, total };
}

export function listMemberLeave(guildId: string, userId: string, since?: Date | null, limit = 25): LeaveRow[] {
  const conditions: SQL[] = [eq(teamLeave.guildId, guildId), eq(teamLeave.userId, userId)];
  if (since) conditions.push(gte(teamLeave.createdAt, since));
  return getDb().select().from(teamLeave).where(and(...conditions)).orderBy(desc(teamLeave.createdAt)).limit(limit).all();
}

/** Taken leave (approved, active, ended) overlapping [from, to), for quota excusal. */
export function leaveOverlapping(guildId: string, from: Date, to: Date): LeaveRow[] {
  return getDb()
    .select()
    .from(teamLeave)
    .where(and(eq(teamLeave.guildId, guildId), inArray(teamLeave.status, ["approved", "active", "ended"]), lt(teamLeave.startsAt, to), gte(teamLeave.endsAt, from)))
    .all();
}

/** Users currently on leave in a guild, by kind. */
export function activeLeaveByUser(guildId: string): Map<string, LeaveRow> {
  const rows = getDb()
    .select()
    .from(teamLeave)
    .where(and(eq(teamLeave.guildId, guildId), eq(teamLeave.status, "active")))
    .all();
  return new Map(rows.map((row) => [row.userId, row]));
}

export function dueLeaveStarts(now = new Date()): LeaveRow[] {
  return getDb().select().from(teamLeave).where(and(eq(teamLeave.status, "approved"), lte(teamLeave.startsAt, now))).all();
}

export function dueLeaveEnds(now = new Date()): LeaveRow[] {
  return getDb().select().from(teamLeave).where(and(eq(teamLeave.status, "active"), lte(teamLeave.endsAt, now))).all();
}

export function countPendingLeave(guildId: string): number {
  return getDb().select({ n: count() }).from(teamLeave).where(and(eq(teamLeave.guildId, guildId), eq(teamLeave.status, "pending"))).get()?.n ?? 0;
}

// ── Actions ──────────────────────────────────────────────────────────────────

export function getAction(guildId: string, id: number): ActionRow | null {
  return getDb().select().from(teamActions).where(and(eq(teamActions.guildId, guildId), eq(teamActions.id, id))).get() ?? null;
}

export function insertAction(row: Omit<typeof teamActions.$inferInsert, "id">): ActionRow {
  return getDb().insert(teamActions).values(row).returning().get();
}

export function voidAction(guildId: string, id: number, voidedBy: string, reason: string): ActionRow | null {
  return (
    getDb()
      .update(teamActions)
      .set({ voidedAt: new Date(), voidedBy, voidReason: reason })
      .where(and(eq(teamActions.guildId, guildId), eq(teamActions.id, id), isNull(teamActions.voidedAt)))
      .returning()
      .get() ?? null
  );
}

export function listActions(
  guildId: string,
  filter: { type?: string | null; userId?: string | null; since?: Date | null; types?: TeamActionType[] },
  limit: number,
  offset = 0,
): Page<ActionRow> {
  const conditions: SQL[] = [eq(teamActions.guildId, guildId)];
  if (filter.type) conditions.push(eq(teamActions.type, filter.type));
  if (filter.types?.length) conditions.push(inArray(teamActions.type, filter.types));
  if (filter.userId) conditions.push(eq(teamActions.userId, filter.userId));
  if (filter.since) conditions.push(gte(teamActions.createdAt, filter.since));
  const where = and(...conditions);
  const db = getDb();
  const rows = db.select().from(teamActions).where(where).orderBy(desc(teamActions.createdAt), desc(teamActions.id)).limit(limit).offset(offset).all();
  const total = db.select({ n: count() }).from(teamActions).where(where).get()?.n ?? 0;
  return { rows, total };
}

/** Strike rows for a set of members (or one), for active-strike counts. */
export function strikeRows(guildId: string, userIds?: string[]): Array<Pick<ActionRow, "userId" | "type" | "voidedAt" | "expiresAt">> {
  if (userIds && userIds.length === 0) return [];
  const conditions: SQL[] = [eq(teamActions.guildId, guildId), eq(teamActions.type, "strike"), isNull(teamActions.voidedAt)];
  if (userIds) conditions.push(inArray(teamActions.userId, userIds));
  return getDb()
    .select({ userId: teamActions.userId, type: teamActions.type, voidedAt: teamActions.voidedAt, expiresAt: teamActions.expiresAt })
    .from(teamActions)
    .where(and(...conditions))
    .all();
}

// ── Notes ────────────────────────────────────────────────────────────────────

export function listNotes(guildId: string, userId: string): NoteRow[] {
  return getDb()
    .select()
    .from(teamNotes)
    .where(and(eq(teamNotes.guildId, guildId), eq(teamNotes.userId, userId)))
    .orderBy(desc(teamNotes.createdAt))
    .limit(50)
    .all();
}

export function insertNote(guildId: string, userId: string, authorId: string, body: string): NoteRow {
  return getDb().insert(teamNotes).values({ guildId, userId, authorId, body, createdAt: new Date() }).returning().get();
}

export function deleteNote(guildId: string, userId: string, id: number): boolean {
  const res = getDb()
    .delete(teamNotes)
    .where(and(eq(teamNotes.guildId, guildId), eq(teamNotes.userId, userId), eq(teamNotes.id, id)))
    .run();
  return res.changes > 0;
}

// ── Feedback ─────────────────────────────────────────────────────────────────

/** Records feedback. A second rating for the same ticket is ignored (returns null). */
export function insertFeedback(row: Omit<typeof teamFeedback.$inferInsert, "id">): FeedbackRow | null {
  return getDb().insert(teamFeedback).values(row).onConflictDoNothing().returning().get() ?? null;
}

export function getFeedback(id: number): FeedbackRow | null {
  return getDb().select().from(teamFeedback).where(eq(teamFeedback.id, id)).get() ?? null;
}

export function setFeedbackComment(id: number, comment: string | null): void {
  getDb().update(teamFeedback).set({ comment }).where(eq(teamFeedback.id, id)).run();
}

export function lastDirectFeedback(guildId: string, raterId: string, staffId: string): Date | null {
  const row = getDb()
    .select({ at: teamFeedback.createdAt })
    .from(teamFeedback)
    .where(and(eq(teamFeedback.guildId, guildId), eq(teamFeedback.raterId, raterId), eq(teamFeedback.staffId, staffId), eq(teamFeedback.source, "direct")))
    .orderBy(desc(teamFeedback.createdAt))
    .get();
  return row?.at ?? null;
}

export function listFeedback(guildId: string, staffId: string | null, limit: number, offset: number, since?: Date | null): Page<FeedbackRow> & { average: number | null } {
  const conditions: SQL[] = [eq(teamFeedback.guildId, guildId)];
  if (staffId) conditions.push(eq(teamFeedback.staffId, staffId));
  if (since) conditions.push(gte(teamFeedback.createdAt, since));
  const where = and(...conditions);
  const db = getDb();
  const rows = db.select().from(teamFeedback).where(where).orderBy(desc(teamFeedback.createdAt)).limit(limit).offset(offset).all();
  const agg = db.select({ n: count(), avg: sql<number | null>`AVG(${teamFeedback.rating})` }).from(teamFeedback).where(where).get();
  return { rows, total: agg?.n ?? 0, average: agg?.avg == null ? null : Math.round(Number(agg.avg) * 100) / 100 };
}

/** Average rating per staff member (within the history window). */
export function feedbackAverages(guildId: string, since?: Date | null): Map<string, number> {
  const conditions: SQL[] = [eq(teamFeedback.guildId, guildId)];
  if (since) conditions.push(gte(teamFeedback.createdAt, since));
  const rows = getDb()
    .select({ staffId: teamFeedback.staffId, avg: sql<number>`AVG(${teamFeedback.rating})` })
    .from(teamFeedback)
    .where(and(...conditions))
    .groupBy(teamFeedback.staffId)
    .all();
  return new Map(rows.map((row) => [row.staffId, Math.round(Number(row.avg) * 100) / 100]));
}

// ── Onboarding ───────────────────────────────────────────────────────────────

export function listOnboarding(guildId: string, userId: string): OnboardingRow[] {
  return getDb()
    .select()
    .from(teamOnboarding)
    .where(and(eq(teamOnboarding.guildId, guildId), eq(teamOnboarding.userId, userId)))
    .all();
}

export function setOnboardingItem(guildId: string, userId: string, itemId: string, done: boolean, by: string | null): void {
  const db = getDb();
  if (!done) {
    db.delete(teamOnboarding)
      .where(and(eq(teamOnboarding.guildId, guildId), eq(teamOnboarding.userId, userId), eq(teamOnboarding.itemId, itemId)))
      .run();
    return;
  }
  db.insert(teamOnboarding).values({ guildId, userId, itemId, doneBy: by, doneAt: new Date() }).onConflictDoNothing().run();
}

// ── Activity counters ────────────────────────────────────────────────────────

/** Adds buffered staff-message counts: one row per member per day. */
export function addStaffMessages(entries: Array<{ guildId: string; userId: string; day: string; n: number }>): void {
  if (entries.length === 0) return;
  const db = getDb();
  db.transaction((tx) => {
    for (const entry of entries) {
      tx.insert(teamActivityDaily)
        .values({ guildId: entry.guildId, userId: entry.userId, day: entry.day, staffMessages: entry.n })
        .onConflictDoUpdate({
          target: [teamActivityDaily.guildId, teamActivityDaily.userId, teamActivityDaily.day],
          set: { staffMessages: sql`${teamActivityDaily.staffMessages} + ${entry.n}` },
        })
        .run();
    }
  });
}

// ── Roster, reports, alerts ──────────────────────────────────────────────────

export function getRosterMessage(guildId: string): typeof teamRosterMessages.$inferSelect | null {
  return getDb().select().from(teamRosterMessages).where(eq(teamRosterMessages.guildId, guildId)).get() ?? null;
}

export function saveRosterMessage(guildId: string, channelId: string, messageId: string, fingerprint: string): void {
  const row = { guildId, channelId, messageId, fingerprint, updatedAt: new Date() };
  getDb()
    .insert(teamRosterMessages)
    .values(row)
    .onConflictDoUpdate({ target: teamRosterMessages.guildId, set: { channelId, messageId, fingerprint, updatedAt: row.updatedAt } })
    .run();
}

export function deleteRosterMessage(guildId: string): void {
  getDb().delete(teamRosterMessages).where(eq(teamRosterMessages.guildId, guildId)).run();
}

/** Claims a period's scheduled report. False when it was already posted. */
export function claimReport(guildId: string, periodStart: string): boolean {
  const res = getDb().insert(teamReports).values({ guildId, periodStart, postedAt: new Date() }).onConflictDoNothing().run();
  return res.changes > 0;
}

export function listInactivityAlerts(guildId: string): Map<string, Date> {
  const rows = getDb().select().from(teamInactivityAlerts).where(eq(teamInactivityAlerts.guildId, guildId)).all();
  return new Map(rows.map((row) => [row.userId, row.alertedAt]));
}

export function setInactivityAlert(guildId: string, userId: string): void {
  getDb().insert(teamInactivityAlerts).values({ guildId, userId, alertedAt: new Date() }).onConflictDoNothing().run();
}

export function clearInactivityAlert(guildId: string, userId: string): void {
  getDb()
    .delete(teamInactivityAlerts)
    .where(and(eq(teamInactivityAlerts.guildId, guildId), eq(teamInactivityAlerts.userId, userId)))
    .run();
}

// ── Retention ────────────────────────────────────────────────────────────────

/** Drops a guild's history older than `before` (members, notes and open items are kept). */
export function pruneGuildHistory(guildId: string, before: Date): number {
  const db = getDb();
  const day = before.toISOString().slice(0, 10);
  let removed = 0;
  removed += db.delete(teamShifts).where(and(eq(teamShifts.guildId, guildId), ne(teamShifts.status, "active"), lt(teamShifts.startedAt, before))).run().changes;
  removed += db
    .delete(teamLeave)
    .where(and(eq(teamLeave.guildId, guildId), inArray(teamLeave.status, ["denied", "ended", "cancelled"]), lt(teamLeave.createdAt, before)))
    .run().changes;
  removed += db.delete(teamActions).where(and(eq(teamActions.guildId, guildId), lt(teamActions.createdAt, before))).run().changes;
  removed += db.delete(teamFeedback).where(and(eq(teamFeedback.guildId, guildId), lt(teamFeedback.createdAt, before))).run().changes;
  removed += db.delete(teamActivityDaily).where(and(eq(teamActivityDaily.guildId, guildId), lt(teamActivityDaily.day, day))).run().changes;
  removed += db.delete(teamReports).where(and(eq(teamReports.guildId, guildId), lt(teamReports.periodStart, day))).run().changes;
  return removed;
}

/** Guilds with any Team Control rows (the sweep also visits these after the plugin is turned off, for retention). */
export function guildsWithTeamData(): string[] {
  const rows = getDb().all<{ guild_id: string }>(sql`SELECT DISTINCT guild_id FROM team_members`);
  return rows.map((row) => row.guild_id);
}

// ── Personal data ────────────────────────────────────────────────────────────

export function exportUserTeamData(userId: string) {
  const db = getDb();
  return {
    memberships: db.select().from(teamMembers).where(eq(teamMembers.userId, userId)).all(),
    shifts: db.select().from(teamShifts).where(eq(teamShifts.userId, userId)).all(),
    leave: db.select().from(teamLeave).where(eq(teamLeave.userId, userId)).all(),
    actions: db.select().from(teamActions).where(eq(teamActions.userId, userId)).all(),
    feedbackReceived: db.select().from(teamFeedback).where(eq(teamFeedback.staffId, userId)).all(),
    feedbackGiven: db.select().from(teamFeedback).where(eq(teamFeedback.raterId, userId)).all(),
    onboarding: db.select().from(teamOnboarding).where(eq(teamOnboarding.userId, userId)).all(),
    activity: db.select().from(teamActivityDaily).where(eq(teamActivityDaily.userId, userId)).all(),
  };
}

export function countUserTeamData(userId: string): number {
  const data = exportUserTeamData(userId);
  return Object.values(data).reduce((sum, rows) => sum + rows.length, 0);
}

/**
 * Erases a member's Team Control data: everything about them (including managers' notes on them),
 * plus notes they wrote. Actions and reviews they made on others are kept but no longer name them.
 */
export function deleteUserTeamData(userId: string): number {
  const db = getDb();
  let removed = 0;
  db.transaction((tx) => {
    removed += tx.delete(teamMembers).where(eq(teamMembers.userId, userId)).run().changes;
    removed += tx.delete(teamShifts).where(eq(teamShifts.userId, userId)).run().changes;
    removed += tx.delete(teamLeave).where(eq(teamLeave.userId, userId)).run().changes;
    removed += tx.delete(teamActions).where(eq(teamActions.userId, userId)).run().changes;
    removed += tx.delete(teamNotes).where(eq(teamNotes.userId, userId)).run().changes;
    removed += tx.delete(teamFeedback).where(or(eq(teamFeedback.staffId, userId), eq(teamFeedback.raterId, userId))).run().changes;
    removed += tx.delete(teamOnboarding).where(eq(teamOnboarding.userId, userId)).run().changes;
    removed += tx.delete(teamActivityDaily).where(eq(teamActivityDaily.userId, userId)).run().changes;
    removed += tx.delete(teamInactivityAlerts).where(eq(teamInactivityAlerts.userId, userId)).run().changes;
    tx.update(teamActions).set({ actorId: null }).where(eq(teamActions.actorId, userId)).run();
    tx.update(teamActions).set({ voidedBy: null }).where(eq(teamActions.voidedBy, userId)).run();
    tx.update(teamLeave).set({ reviewerId: null }).where(eq(teamLeave.reviewerId, userId)).run();
    tx.update(teamShifts).set({ editedBy: null }).where(eq(teamShifts.editedBy, userId)).run();
    tx.update(teamOnboarding).set({ doneBy: null }).where(eq(teamOnboarding.doneBy, userId)).run();
    tx.delete(teamNotes).where(eq(teamNotes.authorId, userId)).run();
  });
  return removed;
}

export type { LeaveKind };
