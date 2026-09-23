import { and, count, desc, eq, like, or, type SQL } from "drizzle-orm";
import type { ApplicationStatus } from "../../../config/schemas/applications.js";
import type { FormAnswer } from "../../../core/formModal.js";
import { getDb } from "../../../db/client.js";
import { applications } from "../../../db/schema.js";

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
    .orderBy(desc(applications.id))
    .limit(query.limit)
    .offset(query.offset)
    .all()
    .map(toRecord);
  return { rows, total, counts };
}
