import { and, asc, count, desc, eq, gte, inArray, isNotNull, like, lte, ne, or, type SQL } from "drizzle-orm";
import type { FormKind, FormStatus, RsvpChoice } from "../../../config/schemas/applications.js";
import type { FormAnswer } from "../../../core/formModal.js";
import { getDb } from "../../../db/client.js";
import { applicationEvents, applications, formReminders } from "../../../db/schema.js";
import { anonymousKey } from "./anonymous.js";

/**
 * Form responses. They live in the `applications` table (Forms grew out of Applications), one
 * row per response, whatever the form's kind.
 */
export type ApplicationRecord = {
  id: number;
  guildId: string;
  openingId: string;
  openingName: string;
  /** The member's id, or an anonymous key (see anonymous.ts) when `anonymous`. */
  userId: string;
  status: FormStatus;
  answers: FormAnswer[];
  reviewChannelId: string | null;
  reviewMessageId: string | null;
  threadId: string | null;
  reviewerId: string | null;
  reason: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  formKind?: FormKind;
  anonymous?: boolean;
  rsvp?: RsvpChoice | null;
  waitlisted?: boolean;
  updatedAt?: Date | null;
};

type Row = typeof applications.$inferSelect;

function parseAnswers(json: string): FormAnswer[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as FormAnswer[]) : [];
  } catch {
    return [];
  }
}

function toRecord(row: Row): ApplicationRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    openingId: row.openingId,
    openingName: row.openingName,
    userId: row.userId,
    status: row.status || "pending",
    answers: parseAnswers(row.answersJson),
    reviewChannelId: row.reviewChannelId,
    reviewMessageId: row.reviewMessageId,
    threadId: row.threadId,
    reviewerId: row.reviewerId,
    reason: row.reason,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    formKind: (row.formKind as FormKind) || "application",
    anonymous: Boolean(row.anonymous),
    rsvp: (row.rsvp as RsvpChoice | null) ?? null,
    waitlisted: Boolean(row.waitlisted),
    updatedAt: row.updatedAt ?? null,
  };
}

export function createApplication(input: {
  guildId: string;
  openingId: string;
  openingName: string;
  userId: string;
  answers: FormAnswer[];
  status?: FormStatus;
  formKind?: FormKind;
  anonymous?: boolean;
  rsvp?: RsvpChoice | null;
  waitlisted?: boolean;
}): ApplicationRecord {
  const row = getDb()
    .insert(applications)
    .values({
      guildId: input.guildId,
      openingId: input.openingId,
      openingName: input.openingName,
      userId: input.userId,
      status: input.status ?? "pending",
      answersJson: JSON.stringify(input.answers),
      createdAt: new Date(),
      formKind: input.formKind ?? "application",
      anonymous: input.anonymous ?? false,
      rsvp: input.rsvp ?? null,
      waitlisted: input.waitlisted ?? false,
      // RSVPs keep their place in the waitlist by when they last changed.
      updatedAt: input.rsvp ? new Date() : null,
    })
    .returning()
    .get();
  return toRecord(row);
}

/** A member editing their own response: new answers, same id and status. */
export function updateAnswers(guildId: string, id: number, answers: FormAnswer[]): ApplicationRecord | null {
  const row = getDb()
    .update(applications)
    .set({ answersJson: JSON.stringify(answers), updatedAt: new Date() })
    .where(and(eq(applications.guildId, guildId), eq(applications.id, id)))
    .returning()
    .get();
  return row ? toRecord(row) : null;
}

export function getApplication(guildId: string, id: number): ApplicationRecord | null {
  const row = getDb()
    .select()
    .from(applications)
    .where(and(eq(applications.guildId, guildId), eq(applications.id, id)))
    .get();
  return row ? toRecord(row) : null;
}

export function setReviewMessage(
  id: number,
  review: { channelId: string; messageId: string; threadId?: string | null },
): void {
  getDb()
    .update(applications)
    .set({ reviewChannelId: review.channelId, reviewMessageId: review.messageId, threadId: review.threadId ?? null })
    .where(eq(applications.id, id))
    .run();
}

/** Both keys a member's responses can be stored under (their id, and their anonymous key). */
export function responderKeys(userId: string): string[] {
  return [userId, anonymousKey(userId)];
}

/** The member's most recent response to a form, for the pending/cooldown checks. */
export function latestApplication(guildId: string, userId: string, openingId: string): ApplicationRecord | null {
  const row = getDb()
    .select()
    .from(applications)
    .where(
      and(eq(applications.guildId, guildId), inArray(applications.userId, responderKeys(userId)), eq(applications.openingId, openingId)),
    )
    .orderBy(desc(applications.id))
    .limit(1)
    .get();
  return row ? toRecord(row) : null;
}

/** What the response limits need: everyone's total, this member's count and their newest one. */
export function responseHistory(guildId: string, userId: string, openingId: string) {
  const db = getDb();
  const total =
    db
      .select({ n: count() })
      .from(applications)
      .where(and(eq(applications.guildId, guildId), eq(applications.openingId, openingId)))
      .get()?.n ?? 0;
  const mine =
    db
      .select({ n: count() })
      .from(applications)
      .where(
        and(eq(applications.guildId, guildId), eq(applications.openingId, openingId), inArray(applications.userId, responderKeys(userId))),
      )
      .get()?.n ?? 0;
  const latest = latestApplication(guildId, userId, openingId);
  return { total, mine, latest };
}

/**
 * Records a decision, but only if the application is still pending. Returns the updated record,
 * or null when someone else decided it first (two reviewers clicking at once never double-apply
 * roles or double-DM the applicant).
 */
export function decideApplication(
  guildId: string,
  id: number,
  decision: "accepted" | "denied",
  reviewerId: string,
  reason: string | null,
): ApplicationRecord | null {
  const row = getDb()
    .update(applications)
    .set({ status: decision, reviewerId, reason, decidedAt: new Date() })
    .where(and(eq(applications.guildId, guildId), eq(applications.id, id), eq(applications.status, "pending")))
    .returning()
    .get();
  return row ? toRecord(row) : null;
}

/**
 * Moves a response to another status (custom review), only from the status the reviewer saw,
 * so two reviewers changing it at once never both run the new status's actions.
 */
export function changeStatus(
  guildId: string,
  id: number,
  from: FormStatus,
  to: FormStatus,
  reviewerId: string,
  reason: string | null,
): ApplicationRecord | null {
  const row = getDb()
    .update(applications)
    .set({ status: to, reviewerId, reason, decidedAt: new Date() })
    .where(and(eq(applications.guildId, guildId), eq(applications.id, id), eq(applications.status, from), ne(applications.status, to)))
    .returning()
    .get();
  return row ? toRecord(row) : null;
}

export type ApplicationsQuery = {
  status: FormStatus | null;
  openingId: string | null;
  userId: string | null;
  q: string;
  /** Newest first unless "oldest" (oldest first is how a queue is usually worked). */
  sort?: "newest" | "oldest";
  limit: number;
  offset: number;
  kind?: FormKind | null;
  rsvp?: RsvpChoice | "waitlist" | null;
  from?: Date | null;
  to?: Date | null;
};

export function listApplications(
  guildId: string,
  query: ApplicationsQuery,
): { rows: ApplicationRecord[]; total: number; counts: Record<string, number> } {
  const db = getDb();
  const filters: SQL[] = [eq(applications.guildId, guildId)];
  if (query.openingId) filters.push(eq(applications.openingId, query.openingId));
  if (query.userId) filters.push(eq(applications.userId, query.userId));
  if (query.kind) filters.push(eq(applications.formKind, query.kind));
  if (query.rsvp === "waitlist") filters.push(eq(applications.rsvp, "going"), eq(applications.waitlisted, true));
  else if (query.rsvp === "going") filters.push(eq(applications.rsvp, "going"), eq(applications.waitlisted, false));
  else if (query.rsvp) filters.push(eq(applications.rsvp, query.rsvp));
  if (query.from) filters.push(gte(applications.createdAt, query.from));
  if (query.to) filters.push(lte(applications.createdAt, query.to));
  if (query.q) {
    const q = query.q;
    if (/^\d{17,20}$/.test(q)) filters.push(eq(applications.userId, q));
    else if (/^\d+$/.test(q)) filters.push(or(eq(applications.id, Number(q)), like(applications.answersJson, `%${q}%`))!);
    else filters.push(or(like(applications.answersJson, `%${q}%`), like(applications.openingName, `%${q}%`))!);
  }

  // Per-status counts use every filter except status itself, so the status tabs show how many
  // each one would hold under the current search.
  const countRows = db
    .select({ status: applications.status, n: count() })
    .from(applications)
    .where(and(...filters))
    .groupBy(applications.status)
    .all();
  const counts: Record<string, number> = { pending: 0, accepted: 0, denied: 0 };
  for (const row of countRows) counts[row.status] = (counts[row.status] ?? 0) + row.n;

  if (query.status) filters.push(eq(applications.status, query.status));
  const where = and(...filters);
  const total = db.select({ n: count() }).from(applications).where(where).get()?.n ?? 0;
  const rows = db
    .select()
    .from(applications)
    .where(where)
    .orderBy(query.sort === "oldest" ? asc(applications.id) : desc(applications.id))
    .limit(query.limit)
    .offset(query.offset)
    .all()
    .map(toRecord);
  return { rows, total, counts };
}

/** Several applications by id, only from this guild. */
export function getApplications(guildId: string, ids: number[]): ApplicationRecord[] {
  if (ids.length === 0) return [];
  return getDb()
    .select()
    .from(applications)
    .where(and(eq(applications.guildId, guildId), inArray(applications.id, ids)))
    .all()
    .map(toRecord);
}

/** Every response this member sent here, newest first (the "Other responses" list). Anonymous ones are left out. */
export function applicationsByUser(guildId: string, userId: string, limit = 20): ApplicationRecord[] {
  return getDb()
    .select()
    .from(applications)
    .where(and(eq(applications.guildId, guildId), eq(applications.userId, userId)))
    .orderBy(desc(applications.id))
    .limit(limit)
    .all()
    .map(toRecord);
}

/** Every response to one form, newest first, for results and CSV export. */
export function responsesForForm(guildId: string, openingId: string, limit = 5000): ApplicationRecord[] {
  return getDb()
    .select()
    .from(applications)
    .where(and(eq(applications.guildId, guildId), eq(applications.openingId, openingId)))
    .orderBy(desc(applications.id))
    .limit(limit)
    .all()
    .map(toRecord);
}

// --- RSVP --------------------------------------------------------------------------------------

export type RsvpCounts = { going: number; maybe: number; not_going: number; waitlisted: number };

export function rsvpCounts(guildId: string, openingId: string): RsvpCounts {
  const rows = getDb()
    .select({ rsvp: applications.rsvp, waitlisted: applications.waitlisted, n: count() })
    .from(applications)
    .where(and(eq(applications.guildId, guildId), eq(applications.openingId, openingId), isNotNull(applications.rsvp)))
    .groupBy(applications.rsvp, applications.waitlisted)
    .all();
  const counts: RsvpCounts = { going: 0, maybe: 0, not_going: 0, waitlisted: 0 };
  for (const row of rows) {
    if (row.rsvp === "going" && row.waitlisted) counts.waitlisted += row.n;
    else if (row.rsvp === "going" || row.rsvp === "maybe" || row.rsvp === "not_going") counts[row.rsvp] += row.n;
  }
  return counts;
}

export function setRsvp(guildId: string, id: number, rsvp: RsvpChoice, waitlisted: boolean): ApplicationRecord | null {
  const row = getDb()
    .update(applications)
    .set({ rsvp, waitlisted, updatedAt: new Date() })
    .where(and(eq(applications.guildId, guildId), eq(applications.id, id)))
    .returning()
    .get();
  return row ? toRecord(row) : null;
}

/** The waitlist in the order people joined it (oldest first). */
export function waitlist(guildId: string, openingId: string, limit = 100): ApplicationRecord[] {
  return getDb()
    .select()
    .from(applications)
    .where(
      and(
        eq(applications.guildId, guildId),
        eq(applications.openingId, openingId),
        eq(applications.rsvp, "going"),
        eq(applications.waitlisted, true),
      ),
    )
    .orderBy(asc(applications.updatedAt), asc(applications.id))
    .limit(limit)
    .all()
    .map(toRecord);
}

/** Everyone confirmed going (not waitlisted), for reminders and the attendee list. */
export function goingResponses(guildId: string, openingId: string, limit = 5000): ApplicationRecord[] {
  return getDb()
    .select()
    .from(applications)
    .where(
      and(
        eq(applications.guildId, guildId),
        eq(applications.openingId, openingId),
        eq(applications.rsvp, "going"),
        eq(applications.waitlisted, false),
      ),
    )
    .orderBy(asc(applications.id))
    .limit(limit)
    .all()
    .map(toRecord);
}

/** RSVP forms that have anyone going, across every server (for the reminder sweep). */
export function rsvpFormsWithAttendees(): Array<{ guildId: string; openingId: string }> {
  return getDb()
    .selectDistinct({ guildId: applications.guildId, openingId: applications.openingId })
    .from(applications)
    .where(and(eq(applications.formKind, "rsvp"), eq(applications.rsvp, "going")))
    .all();
}

/** Claims an event's reminder: true for the first caller only. */
export function claimReminder(guildId: string, openingId: string, startsAt: string): boolean {
  const result = getDb()
    .insert(formReminders)
    .values({ guildId, openingId, startsAt, sentAt: new Date() })
    .onConflictDoNothing()
    .run();
  return result.changes > 0;
}

// --- Erase / export ----------------------------------------------------------------------------

/** Every response a member sent, in any server, anonymous ones included (for their data export). */
export function responsesByMember(userId: string): ApplicationRecord[] {
  return getDb()
    .select()
    .from(applications)
    .where(inArray(applications.userId, responderKeys(userId)))
    .orderBy(asc(applications.id))
    .all()
    .map(toRecord);
}

/** Deletes every response a member sent (and the staff notes on them). Returns how many. */
export function deleteResponsesByMember(userId: string): { responses: number; notes: number } {
  const db = getDb();
  const ids = db
    .select({ id: applications.id })
    .from(applications)
    .where(inArray(applications.userId, responderKeys(userId)))
    .all()
    .map((row) => row.id);
  if (ids.length === 0) return { responses: 0, notes: 0 };
  let notes = 0;
  let responses = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    notes += db.delete(applicationEvents).where(inArray(applicationEvents.applicationId, chunk)).run().changes;
    responses += db.delete(applications).where(inArray(applications.id, chunk)).run().changes;
  }
  return { responses, notes };
}

export function countResponsesByMember(userId: string): number {
  return (
    getDb()
      .select({ n: count() })
      .from(applications)
      .where(inArray(applications.userId, responderKeys(userId)))
      .get()?.n ?? 0
  );
}

// --- Activity log (staff notes) ---------------------------------------------------------------

export type ApplicationEvent = {
  id: number;
  applicationId: number;
  kind: string;
  actorId: string | null;
  content: string | null;
  createdAt: Date;
};

function toEvent(row: typeof applicationEvents.$inferSelect): ApplicationEvent {
  return {
    id: row.id,
    applicationId: row.applicationId,
    kind: row.kind,
    actorId: row.actorId,
    content: row.content,
    createdAt: row.createdAt,
  };
}

export function listApplicationEvents(guildId: string, applicationId: number): ApplicationEvent[] {
  return getDb()
    .select()
    .from(applicationEvents)
    .where(and(eq(applicationEvents.guildId, guildId), eq(applicationEvents.applicationId, applicationId)))
    .orderBy(asc(applicationEvents.id))
    .all()
    .map(toEvent);
}

export function addApplicationEvent(input: {
  guildId: string;
  applicationId: number;
  /** "note" is a staff note; "status", "edit" and "rsvp" are logged automatically. */
  kind: "note" | "status" | "edit" | "rsvp";
  actorId: string | null;
  content: string;
}): ApplicationEvent {
  const row = getDb()
    .insert(applicationEvents)
    .values({ ...input, createdAt: new Date() })
    .returning()
    .get();
  return toEvent(row);
}

export function deleteApplicationEvent(guildId: string, applicationId: number, eventId: number): boolean {
  const result = getDb()
    .delete(applicationEvents)
    .where(
      and(
        eq(applicationEvents.guildId, guildId),
        eq(applicationEvents.applicationId, applicationId),
        eq(applicationEvents.id, eventId),
        eq(applicationEvents.kind, "note"),
      ),
    )
    .run();
  return result.changes > 0;
}

/** Staff notes per application, for the list's note badges. */
export function noteCounts(guildId: string, applicationIds: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (applicationIds.length === 0) return out;
  const rows = getDb()
    .select({ id: applicationEvents.applicationId, n: count() })
    .from(applicationEvents)
    .where(
      and(
        eq(applicationEvents.guildId, guildId),
        eq(applicationEvents.kind, "note"),
        inArray(applicationEvents.applicationId, applicationIds),
      ),
    )
    .groupBy(applicationEvents.applicationId)
    .all();
  for (const row of rows) out.set(row.id, row.n);
  return out;
}

// --- Stats ------------------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

export type ApplicationOpeningStats = {
  openingId: string;
  openingName: string;
  kind: FormKind;
  total: number;
  pending: number;
  accepted: number;
  denied: number;
  /** Every status, custom ones included. */
  byStatus: Record<string, number>;
};

export type ApplicationStats = {
  total: number;
  /** pending/accepted/denied always present, plus "submitted" and custom statuses when used. */
  byStatus: Record<string, number>;
  /** Per form (by the id responded to), with the name it had on the newest response. */
  byOpening: ApplicationOpeningStats[];
  last7d: number;
  last30d: number;
  /** Share of decided applications that were accepted, 0..1 (null when nothing is decided). */
  acceptRate: number | null;
  /** Average time from submission to decision over the last 90 days, in ms (null when none). */
  avgDecisionMs: number | null;
  /** The longest-waiting pending response's submission time. */
  oldestPendingAt: Date | null;
  /** New responses per day, oldest first, last 30 days (today last). */
  daily: number[];
};

/** Daily counts over the last `days` days (today last). */
function dailyCounts(dates: Date[], days: number, now: number): number[] {
  const daily = new Array<number>(days).fill(0);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  for (const date of dates) {
    const at = date.getTime();
    const daysAgo = at >= todayStart.getTime() ? 0 : Math.ceil((todayStart.getTime() - at) / DAY_MS);
    const index = days - 1 - daysAgo;
    if (index >= 0 && index < days) daily[index]! += 1;
  }
  return daily;
}

export function applicationStats(guildId: string, openingId?: string | null): ApplicationStats {
  const db = getDb();
  const scope = openingId
    ? and(eq(applications.guildId, guildId), eq(applications.openingId, openingId))
    : eq(applications.guildId, guildId);
  const grouped = db
    .select({ openingId: applications.openingId, kind: applications.formKind, status: applications.status, n: count() })
    .from(applications)
    .where(scope)
    .groupBy(applications.openingId, applications.formKind, applications.status)
    .all();
  const byStatus: Record<string, number> = { pending: 0, accepted: 0, denied: 0 };
  const openings = new Map<string, ApplicationOpeningStats>();
  for (const row of grouped) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + row.n;
    let entry = openings.get(row.openingId);
    if (!entry) {
      entry = {
        openingId: row.openingId,
        openingName: "",
        kind: (row.kind as FormKind) || "application",
        total: 0,
        pending: 0,
        accepted: 0,
        denied: 0,
        byStatus: {},
      };
      openings.set(row.openingId, entry);
    }
    if (row.status === "pending" || row.status === "accepted" || row.status === "denied") entry[row.status] += row.n;
    entry.byStatus[row.status] = (entry.byStatus[row.status] ?? 0) + row.n;
    entry.total += row.n;
  }
  if (openings.size > 0) {
    const names = db
      .select({ openingId: applications.openingId, openingName: applications.openingName })
      .from(applications)
      .where(and(eq(applications.guildId, guildId), inArray(applications.openingId, [...openings.keys()])))
      .orderBy(desc(applications.id))
      .all();
    for (const row of names) {
      const entry = openings.get(row.openingId);
      if (entry && !entry.openingName) entry.openingName = row.openingName;
    }
  }

  const now = Date.now();
  const recent = db
    .select({ at: applications.createdAt })
    .from(applications)
    .where(and(scope, gte(applications.createdAt, new Date(now - 30 * DAY_MS))))
    .all();
  const last7d = recent.filter((row) => row.at.getTime() >= now - 7 * DAY_MS).length;

  const decided = db
    .select({ createdAt: applications.createdAt, decidedAt: applications.decidedAt })
    .from(applications)
    .where(and(scope, isNotNull(applications.decidedAt), gte(applications.decidedAt, new Date(now - 90 * DAY_MS))))
    .all();
  const waits = decided
    .map((row) => (row.decidedAt ? row.decidedAt.getTime() - row.createdAt.getTime() : -1))
    .filter((ms) => ms >= 0);

  const oldest = db
    .select({ at: applications.createdAt })
    .from(applications)
    .where(and(scope, eq(applications.status, "pending")))
    .orderBy(asc(applications.id))
    .limit(1)
    .get();

  const decidedTotal = (byStatus.accepted ?? 0) + (byStatus.denied ?? 0);
  return {
    total: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
    byStatus,
    byOpening: [...openings.values()].sort((a, b) => b.pending - a.pending || b.total - a.total),
    last7d,
    last30d: recent.length,
    acceptRate: decidedTotal ? (byStatus.accepted ?? 0) / decidedTotal : null,
    avgDecisionMs: waits.length ? waits.reduce((sum, ms) => sum + ms, 0) / waits.length : null,
    oldestPendingAt: oldest?.at ?? null,
    daily: dailyCounts(
      recent.map((row) => row.at),
      30,
      now,
    ),
  };
}

export { dailyCounts };
