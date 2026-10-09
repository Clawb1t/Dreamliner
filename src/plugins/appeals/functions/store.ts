import { and, asc, count, desc, eq, inArray, like, or, type SQL } from "drizzle-orm";
import type { AppealStatus } from "../../../config/schemas/appeals.js";
import type { FormAnswer } from "../../../core/formModal.js";
import { getDb } from "../../../db/client.js";
import { appealEvents, appeals } from "../../../db/schema.js";

/** The infraction as it was when appealed, so later edits to the case don't rewrite the appeal. */
export type CaseSnapshot = {
  type: string;
  reason: string | null;
  modId: string;
  active: boolean;
  createdAt: string;
  expiresAt: string | null;
};

export type AppealRecord = {
  id: number;
  guildId: string;
  userId: string;
  caseId: number | null;
  kind: "case" | "manual";
  infractionType: string | null;
  caseSnapshot: CaseSnapshot | null;
  formId: string;
  formName: string;
  answers: FormAnswer[];
  status: AppealStatus;
  reviewerId: string | null;
  decisionReason: string | null;
  reversed: boolean;
  reversalNote: string | null;
  reviewChannelId: string | null;
  reviewMessageId: string | null;
  threadId: string | null;
  createdAt: Date;
  updatedAt: Date;
  decidedAt: Date | null;
};

export type AppealEventKind =
  | "submitted"
  | "info_requested"
  | "info_replied"
  | "note"
  | "approved"
  | "denied"
  | "withdrawn"
  | "reversed";

export type AppealEvent = {
  id: number;
  appealId: number;
  kind: AppealEventKind;
  actorId: string | null;
  body: string | null;
  createdAt: Date;
};

/** Statuses an appeal can still be acted on in. */
export const OPEN_STATUSES: AppealStatus[] = ["pending", "needs_info"];

type Row = typeof appeals.$inferSelect;

function parseJson<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function toRecord(row: Row): AppealRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    userId: row.userId,
    caseId: row.caseId,
    kind: row.kind === "manual" ? "manual" : "case",
    infractionType: row.infractionType,
    caseSnapshot: parseJson<CaseSnapshot | null>(row.caseSnapshotJson, null),
    formId: row.formId,
    formName: row.formName,
    answers: parseJson<FormAnswer[]>(row.answersJson, []),
    status: (row.status as AppealStatus) ?? "pending",
    reviewerId: row.reviewerId,
    decisionReason: row.decisionReason,
    reversed: row.reversed,
    reversalNote: row.reversalNote,
    reviewChannelId: row.reviewChannelId,
    reviewMessageId: row.reviewMessageId,
    threadId: row.threadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    decidedAt: row.decidedAt,
  };
}

export function createAppeal(input: {
  guildId: string;
  userId: string;
  caseId: number | null;
  infractionType: string | null;
  caseSnapshot: CaseSnapshot | null;
  formId: string;
  formName: string;
  answers: FormAnswer[];
}): AppealRecord {
  const now = new Date();
  const row = getDb()
    .insert(appeals)
    .values({
      guildId: input.guildId,
      userId: input.userId,
      caseId: input.caseId,
      kind: input.caseId === null ? "manual" : "case",
      infractionType: input.infractionType,
      caseSnapshotJson: input.caseSnapshot ? JSON.stringify(input.caseSnapshot) : null,
      formId: input.formId,
      formName: input.formName,
      answersJson: JSON.stringify(input.answers),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  addEvent(row.id, "submitted", input.userId, null);
  return toRecord(row);
}

export function getAppeal(guildId: string, id: number): AppealRecord | null {
  const row = getDb()
    .select()
    .from(appeals)
    .where(and(eq(appeals.guildId, guildId), eq(appeals.id, id)))
    .get();
  return row ? toRecord(row) : null;
}

/** Every appeal a user has made in a server, newest first. */
export function listUserAppeals(guildId: string, userId: string): AppealRecord[] {
  return getDb()
    .select()
    .from(appeals)
    .where(and(eq(appeals.guildId, guildId), eq(appeals.userId, userId)))
    .orderBy(desc(appeals.id))
    .all()
    .map(toRecord);
}

/** Appeals against specific infractions (for the Cases page). */
export function listCaseAppeals(guildId: string, caseIds: number[]): AppealRecord[] {
  if (caseIds.length === 0) return [];
  return getDb()
    .select()
    .from(appeals)
    .where(and(eq(appeals.guildId, guildId), inArray(appeals.caseId, caseIds)))
    .orderBy(desc(appeals.id))
    .all()
    .map(toRecord);
}

export function setReviewMessage(id: number, review: { channelId: string; messageId: string; threadId: string | null }): void {
  getDb()
    .update(appeals)
    .set({ reviewChannelId: review.channelId, reviewMessageId: review.messageId, threadId: review.threadId })
    .where(eq(appeals.id, id))
    .run();
}

/**
 * Moves an appeal from one of `from` to `to`, only if it's still in one of `from`. Returns the
 * updated record, or null when it had already moved on: two reviewers acting at once never
 * double-unban or double-DM.
 */
export function transitionAppeal(
  guildId: string,
  id: number,
  from: AppealStatus[],
  to: AppealStatus,
  patch: Partial<Pick<Row, "reviewerId" | "decisionReason" | "decidedAt">> = {},
): AppealRecord | null {
  const row = getDb()
    .update(appeals)
    .set({ status: to, updatedAt: new Date(), ...patch })
    .where(and(eq(appeals.guildId, guildId), eq(appeals.id, id), inArray(appeals.status, from)))
    .returning()
    .get();
  return row ? toRecord(row) : null;
}

export function setReversal(id: number, reversed: boolean, note: string | null): AppealRecord | null {
  const row = getDb()
    .update(appeals)
    .set({ reversed, reversalNote: note, updatedAt: new Date() })
    .where(eq(appeals.id, id))
    .returning()
    .get();
  return row ? toRecord(row) : null;
}

export function addEvent(appealId: number, kind: AppealEventKind, actorId: string | null, body: string | null): AppealEvent {
  const row = getDb()
    .insert(appealEvents)
    .values({ appealId, kind, actorId, body, createdAt: new Date() })
    .returning()
    .get();
  return { ...row, kind: row.kind as AppealEventKind };
}

/** An appeal's timeline, oldest first. Staff-only notes are left out unless asked for. */
export function listEvents(appealId: number, includeNotes: boolean): AppealEvent[] {
  return getDb()
    .select()
    .from(appealEvents)
    .where(eq(appealEvents.appealId, appealId))
    .orderBy(asc(appealEvents.id))
    .all()
    .filter((row) => includeNotes || row.kind !== "note")
    .map((row) => ({ ...row, kind: row.kind as AppealEventKind }));
}

/** The most recent staff question on an appeal waiting for the user's reply. */
export function latestQuestion(appealId: number): AppealEvent | null {
  const events = listEvents(appealId, false).filter((event) => event.kind === "info_requested");
  return events.at(-1) ?? null;
}

export type AppealsQuery = {
  status: AppealStatus | null;
  type: string | null;
  userId: string | null;
  q: string;
  limit: number;
  offset: number;
};

export function listAppeals(
  guildId: string,
  query: AppealsQuery,
): { rows: AppealRecord[]; total: number; counts: Record<AppealStatus, number> } {
  const db = getDb();
  const filters: SQL[] = [eq(appeals.guildId, guildId)];
  if (query.type) filters.push(eq(appeals.infractionType, query.type));
  if (query.userId) filters.push(eq(appeals.userId, query.userId));
  if (query.q) {
    const q = query.q.replace(/^#/, "");
    if (/^\d{17,20}$/.test(q)) filters.push(eq(appeals.userId, q));
    else if (/^\d+$/.test(q)) filters.push(or(eq(appeals.id, Number(q)), eq(appeals.caseId, Number(q)))!);
    else filters.push(like(appeals.answersJson, `%${q}%`));
  }

  // Per-status counts use every filter except status itself, so the tabs show what each holds.
  const counts: Record<AppealStatus, number> = { pending: 0, needs_info: 0, approved: 0, denied: 0, withdrawn: 0 };
  for (const row of db
    .select({ status: appeals.status, n: count() })
    .from(appeals)
    .where(and(...filters))
    .groupBy(appeals.status)
    .all()) {
    if (row.status in counts) counts[row.status as AppealStatus] = row.n;
  }

  if (query.status) filters.push(eq(appeals.status, query.status));
  const where = and(...filters);
  const total = db.select({ n: count() }).from(appeals).where(where).get()?.n ?? 0;
  const rows = db
    .select()
    .from(appeals)
    .where(where)
    .orderBy(desc(appeals.id))
    .limit(query.limit)
    .offset(query.offset)
    .all()
    .map(toRecord);
  return { rows, total, counts };
}

/** Pending count, approval rate and average time to a decision over the last `days`. */
export function appealStats(guildId: string, days: number): {
  pending: number;
  decided: number;
  approved: number;
  averageDecisionMs: number | null;
} {
  const since = Date.now() - days * 86_400_000;
  const rows = getDb().select().from(appeals).where(eq(appeals.guildId, guildId)).all();
  const pending = rows.filter((row) => OPEN_STATUSES.includes(row.status as AppealStatus)).length;
  const decided = rows.filter(
    (row) => (row.status === "approved" || row.status === "denied") && row.decidedAt && row.decidedAt.getTime() >= since,
  );
  const approved = decided.filter((row) => row.status === "approved").length;
  const averageDecisionMs =
    decided.length > 0
      ? Math.round(decided.reduce((sum, row) => sum + (row.decidedAt!.getTime() - row.createdAt.getTime()), 0) / decided.length)
      : null;
  return { pending, decided: decided.length, approved, averageDecisionMs };
}
