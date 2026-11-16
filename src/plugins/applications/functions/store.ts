import { and, asc, count, desc, eq, gte, inArray, isNotNull, like, or, type SQL } from "drizzle-orm";
import type { ApplicationStatus } from "../../../config/schemas/applications.js";
import type { FormAnswer } from "../../../core/formModal.js";
import { getDb } from "../../../db/client.js";
import { applicationEvents, applications } from "../../../db/schema.js";

export type ApplicationRecord = {
  id: number;
  guildId: string;
  openingId: string;
  openingName: string;
  userId: string;
  status: ApplicationStatus;
  answers: FormAnswer[];
  reviewChannelId: string | null;
  reviewMessageId: string | null;
  threadId: string | null;
  reviewerId: string | null;
  reason: string | null;
  createdAt: Date;
  decidedAt: Date | null;
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
    status: (row.status as ApplicationStatus) ?? "pending",
    answers: parseAnswers(row.answersJson),
    reviewChannelId: row.reviewChannelId,
    reviewMessageId: row.reviewMessageId,
    threadId: row.threadId,
    reviewerId: row.reviewerId,
    reason: row.reason,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
  };
}

export function createApplication(input: {
  guildId: string;
  openingId: string;
  openingName: string;
  userId: string;
  answers: FormAnswer[];
}): ApplicationRecord {
  const row = getDb()
    .insert(applications)
    .values({
      guildId: input.guildId,
      openingId: input.openingId,
      openingName: input.openingName,
      userId: input.userId,
      status: "pending",
      answersJson: JSON.stringify(input.answers),
      createdAt: new Date(),
    })
    .returning()
    .get();
  return toRecord(row);
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

/** The member's most recent application for an opening, for the pending/cooldown checks. */
export function latestApplication(guildId: string, userId: string, openingId: string): ApplicationRecord | null {
  const row = getDb()
    .select()
    .from(applications)
    .where(
      and(eq(applications.guildId, guildId), eq(applications.userId, userId), eq(applications.openingId, openingId)),
    )
    .orderBy(desc(applications.id))
    .limit(1)
    .get();
  return row ? toRecord(row) : null;
}

/**
 * Records a decision, but only if the application is still pending. Returns the updated record,
 * or null when someone else decided it first (two reviewers clicking at once never double-apply
 * roles or double-DM the applicant).
 */
export function decideApplication(
  guildId: string,
  id: number,
  decision: Exclude<ApplicationStatus, "pending">,
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

export type ApplicationsQuery = {
  status: ApplicationStatus | null;
  openingId: string | null;
  userId: string | null;
  q: string;
  /** Newest first unless "oldest" (oldest first is how a queue is usually worked). */
  sort?: "newest" | "oldest";
  limit: number;
  offset: number;
};

export function listApplications(
  guildId: string,
  query: ApplicationsQuery,
): { rows: ApplicationRecord[]; total: number; counts: Record<ApplicationStatus, number> } {
  const db = getDb();
  const filters: SQL[] = [eq(applications.guildId, guildId)];
  if (query.openingId) filters.push(eq(applications.openingId, query.openingId));
  if (query.userId) filters.push(eq(applications.userId, query.userId));
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
  const counts: Record<ApplicationStatus, number> = { pending: 0, accepted: 0, denied: 0 };
  for (const row of countRows) {
    if (row.status in counts) counts[row.status as ApplicationStatus] = row.n;
  }

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

/** Every application this member sent here, newest first (the "Other applications" list). */
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
  kind: "note";
  actorId: string;
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
  total: number;
  pending: number;
  accepted: number;
  denied: number;
};

export type ApplicationStats = {
  total: number;
  byStatus: Record<ApplicationStatus, number>;
  /** Per opening (by the id applied to), with the name it had on the newest application. */
  byOpening: ApplicationOpeningStats[];
  last7d: number;
  last30d: number;
  /** Share of decided applications that were accepted, 0..1 (null when nothing is decided). */
  acceptRate: number | null;
  /** Average time from submission to decision over the last 90 days, in ms (null when none). */
  avgDecisionMs: number | null;
  /** The longest-waiting pending application's submission time. */
  oldestPendingAt: Date | null;
  /** New applications per day, oldest first, last 30 days (today last). */
  daily: number[];
};

export function applicationStats(guildId: string): ApplicationStats {
  const db = getDb();
  const grouped = db
    .select({ openingId: applications.openingId, status: applications.status, n: count() })
    .from(applications)
    .where(eq(applications.guildId, guildId))
    .groupBy(applications.openingId, applications.status)
    .all();
  const byStatus: Record<ApplicationStatus, number> = { pending: 0, accepted: 0, denied: 0 };
  const openings = new Map<string, ApplicationOpeningStats>();
  for (const row of grouped) {
    const status = row.status as ApplicationStatus;
    if (!(status in byStatus)) continue;
    byStatus[status] += row.n;
    let entry = openings.get(row.openingId);
    if (!entry) {
      entry = { openingId: row.openingId, openingName: "", total: 0, pending: 0, accepted: 0, denied: 0 };
      openings.set(row.openingId, entry);
    }
    entry[status] += row.n;
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
    .where(and(eq(applications.guildId, guildId), gte(applications.createdAt, new Date(now - 30 * DAY_MS))))
    .all();
  const daily = new Array<number>(30).fill(0);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  let last7d = 0;
  for (const row of recent) {
    const at = row.at.getTime();
    if (at >= now - 7 * DAY_MS) last7d++;
    const daysAgo = at >= todayStart.getTime() ? 0 : Math.ceil((todayStart.getTime() - at) / DAY_MS);
    const index = 29 - daysAgo;
    if (index >= 0 && index < 30) daily[index]! += 1;
  }

  const decided = db
    .select({ createdAt: applications.createdAt, decidedAt: applications.decidedAt })
    .from(applications)
    .where(
      and(
        eq(applications.guildId, guildId),
        isNotNull(applications.decidedAt),
        gte(applications.decidedAt, new Date(now - 90 * DAY_MS)),
      ),
    )
    .all();
  const waits = decided
    .map((row) => (row.decidedAt ? row.decidedAt.getTime() - row.createdAt.getTime() : -1))
    .filter((ms) => ms >= 0);

  const oldest = db
    .select({ at: applications.createdAt })
    .from(applications)
    .where(and(eq(applications.guildId, guildId), eq(applications.status, "pending")))
    .orderBy(asc(applications.id))
    .limit(1)
    .get();

  const decidedTotal = byStatus.accepted + byStatus.denied;
  return {
    total: byStatus.pending + decidedTotal,
    byStatus,
    byOpening: [...openings.values()].sort((a, b) => b.pending - a.pending || b.total - a.total),
    last7d,
    last30d: recent.length,
    acceptRate: decidedTotal ? byStatus.accepted / decidedTotal : null,
    avgDecisionMs: waits.length ? waits.reduce((sum, ms) => sum + ms, 0) / waits.length : null,
    oldestPendingAt: oldest?.at ?? null,
    daily,
  };
}
