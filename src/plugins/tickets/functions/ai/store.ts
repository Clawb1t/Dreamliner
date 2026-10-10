import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { getDb } from "../../../../db/client.js";
import { ticketAiGuildState, ticketAiKnowledge, ticketAiState, ticketAiUsageDaily } from "../../../../db/schema.js";
import { MAX_TICKET_AI_KNOWLEDGE } from "../../../../config/schemas/ticketAi.js";

/** Storage for the tickets AI Responder: knowledge, per-ticket state, daily usage. */

export type KnowledgeKind = "faq" | "note" | "autotrain" | "learned";
export type KnowledgeStatus = "active" | "pending" | "rejected";
export type TicketAiMode = "ai" | "staff" | "escalated";

export type KnowledgeEntry = {
  id: number;
  guildId: string;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  title: string;
  content: string;
  source: string | null;
  createdBy: string | null;
  uses: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TicketAiState = {
  ticketId: number;
  guildId: string;
  mode: TicketAiMode;
  aiReplies: number;
  reason: string | null;
  changedBy: string | null;
  escalatedAt: Date | null;
  learnedAt: Date | null;
};

type KnowledgeRow = typeof ticketAiKnowledge.$inferSelect;
type StateRow = typeof ticketAiState.$inferSelect;

function toEntry(row: KnowledgeRow): KnowledgeEntry {
  return { ...row, kind: row.kind as KnowledgeKind, status: row.status as KnowledgeStatus };
}

function toState(row: StateRow): TicketAiState {
  return {
    ticketId: row.ticketId,
    guildId: row.guildId,
    mode: row.mode as TicketAiMode,
    aiReplies: row.aiReplies,
    reason: row.reason,
    changedBy: row.changedBy,
    escalatedAt: row.escalatedAt,
    learnedAt: row.learnedAt,
  };
}

// --- Knowledge -------------------------------------------------------------------------------

export function listKnowledge(
  guildId: string,
  filter: { kind?: KnowledgeKind | null; status?: KnowledgeStatus | null; q?: string; limit?: number; offset?: number } = {},
): { rows: KnowledgeEntry[]; total: number } {
  const conditions = [eq(ticketAiKnowledge.guildId, guildId)];
  if (filter.kind) conditions.push(eq(ticketAiKnowledge.kind, filter.kind));
  if (filter.status) conditions.push(eq(ticketAiKnowledge.status, filter.status));
  const q = filter.q?.trim();
  if (q) {
    const pattern = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(or(like(ticketAiKnowledge.title, pattern), like(ticketAiKnowledge.content, pattern))!);
  }
  const where = and(...conditions);
  const total = getDb().select({ n: sql<number>`count(*)` }).from(ticketAiKnowledge).where(where).get()?.n ?? 0;
  const rows = getDb()
    .select()
    .from(ticketAiKnowledge)
    .where(where)
    .orderBy(desc(ticketAiKnowledge.updatedAt))
    .limit(Math.min(200, filter.limit ?? 100))
    .offset(filter.offset ?? 0)
    .all()
    .map(toEntry);
  return { rows, total };
}

/** Everything the AI may use when answering (active entries only). */
export function activeKnowledge(guildId: string): KnowledgeEntry[] {
  return getDb()
    .select()
    .from(ticketAiKnowledge)
    .where(and(eq(ticketAiKnowledge.guildId, guildId), eq(ticketAiKnowledge.status, "active")))
    .all()
    .map(toEntry);
}

export function knowledgeCounts(guildId: string): Record<KnowledgeKind, number> & { pending: number; total: number } {
  const counts = { faq: 0, note: 0, autotrain: 0, learned: 0, pending: 0, total: 0 };
  const rows = getDb()
    .select({ kind: ticketAiKnowledge.kind, status: ticketAiKnowledge.status, n: sql<number>`count(*)` })
    .from(ticketAiKnowledge)
    .where(eq(ticketAiKnowledge.guildId, guildId))
    .groupBy(ticketAiKnowledge.kind, ticketAiKnowledge.status)
    .all();
  for (const row of rows) {
    if (row.status === "pending") counts.pending += row.n;
    if (row.status === "rejected") continue;
    counts.total += row.n;
    if (row.kind in counts) counts[row.kind as KnowledgeKind] += row.n;
  }
  return counts;
}

export function getKnowledge(guildId: string, id: number): KnowledgeEntry | null {
  const row = getDb()
    .select()
    .from(ticketAiKnowledge)
    .where(and(eq(ticketAiKnowledge.guildId, guildId), eq(ticketAiKnowledge.id, id)))
    .get();
  return row ? toEntry(row) : null;
}

export class KnowledgeLimitError extends Error {}

export function addKnowledge(input: {
  guildId: string;
  kind: KnowledgeKind;
  status?: KnowledgeStatus;
  title: string;
  content: string;
  source?: string | null;
  createdBy?: string | null;
}): KnowledgeEntry {
  const count =
    getDb()
      .select({ n: sql<number>`count(*)` })
      .from(ticketAiKnowledge)
      .where(and(eq(ticketAiKnowledge.guildId, input.guildId), inArray(ticketAiKnowledge.status, ["active", "pending"])))
      .get()?.n ?? 0;
  if (count >= MAX_TICKET_AI_KNOWLEDGE) {
    throw new KnowledgeLimitError(`The knowledge base is full (${MAX_TICKET_AI_KNOWLEDGE} entries). Delete some first.`);
  }
  const now = new Date();
  const row = getDb()
    .insert(ticketAiKnowledge)
    .values({
      guildId: input.guildId,
      kind: input.kind,
      status: input.status ?? "active",
      title: input.title.trim().slice(0, 200),
      content: input.content.trim().slice(0, 4000),
      source: input.source ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toEntry(row);
}

export function updateKnowledge(
  guildId: string,
  id: number,
  patch: Partial<Pick<KnowledgeEntry, "title" | "content" | "status">>,
): KnowledgeEntry | null {
  const set: Partial<KnowledgeRow> = { updatedAt: new Date() };
  if (patch.title !== undefined) set.title = patch.title.trim().slice(0, 200);
  if (patch.content !== undefined) set.content = patch.content.trim().slice(0, 4000);
  if (patch.status !== undefined) set.status = patch.status;
  const row = getDb()
    .update(ticketAiKnowledge)
    .set(set)
    .where(and(eq(ticketAiKnowledge.guildId, guildId), eq(ticketAiKnowledge.id, id)))
    .returning()
    .get();
  return row ? toEntry(row) : null;
}

export function deleteKnowledge(guildId: string, id: number): boolean {
  const row = getDb()
    .delete(ticketAiKnowledge)
    .where(and(eq(ticketAiKnowledge.guildId, guildId), eq(ticketAiKnowledge.id, id)))
    .returning({ id: ticketAiKnowledge.id })
    .get();
  return Boolean(row);
}

/** Bumps the use counters on entries the AI relied on for a reply. */
export function markKnowledgeUsed(guildId: string, ids: number[]): void {
  if (ids.length === 0) return;
  getDb()
    .update(ticketAiKnowledge)
    .set({ uses: sql`${ticketAiKnowledge.uses} + 1`, lastUsedAt: new Date() })
    .where(and(eq(ticketAiKnowledge.guildId, guildId), inArray(ticketAiKnowledge.id, ids)))
    .run();
}

// --- Per-ticket state ------------------------------------------------------------------------

export function getTicketAiState(ticketId: number): TicketAiState | null {
  const row = getDb().select().from(ticketAiState).where(eq(ticketAiState.ticketId, ticketId)).get();
  return row ? toState(row) : null;
}

export function ticketAiStatesFor(ticketIds: number[]): Map<number, TicketAiState> {
  if (ticketIds.length === 0) return new Map();
  const rows = getDb().select().from(ticketAiState).where(inArray(ticketAiState.ticketId, ticketIds)).all();
  return new Map(rows.map((row) => [row.ticketId, toState(row)]));
}

export function startTicketAiState(ticketId: number, guildId: string): TicketAiState {
  const now = new Date();
  const row = getDb()
    .insert(ticketAiState)
    .values({ ticketId, guildId, mode: "ai", aiReplies: 0, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: ticketAiState.ticketId, set: { mode: "ai", updatedAt: now } })
    .returning()
    .get();
  return toState(row);
}

/**
 * Moves a ticket between AI, staff and escalated. `from` guards the change (only applies while the
 * ticket is in one of those modes), so two things racing to escalate only escalate once.
 */
export function setTicketAiMode(
  ticketId: number,
  mode: TicketAiMode,
  options: { from?: TicketAiMode[]; reason?: string | null; changedBy?: string | null; resetReplies?: boolean } = {},
): TicketAiState | null {
  const now = new Date();
  const set: Partial<StateRow> = { mode, updatedAt: now, reason: options.reason ?? null, changedBy: options.changedBy ?? null };
  if (mode === "escalated") set.escalatedAt = now;
  if (options.resetReplies) set.aiReplies = 0;
  const conditions = [eq(ticketAiState.ticketId, ticketId)];
  if (options.from?.length) conditions.push(inArray(ticketAiState.mode, options.from));
  const row = getDb().update(ticketAiState).set(set).where(and(...conditions)).returning().get();
  return row ? toState(row) : null;
}

export function countAiReply(ticketId: number): void {
  getDb()
    .update(ticketAiState)
    .set({ aiReplies: sql`${ticketAiState.aiReplies} + 1`, updatedAt: new Date() })
    .where(eq(ticketAiState.ticketId, ticketId))
    .run();
}

/** Claims the one-time "learn from this ticket" step; false if it was already done. */
export function claimTicketLearning(ticketId: number): boolean {
  const row = getDb()
    .update(ticketAiState)
    .set({ learnedAt: new Date() })
    .where(and(eq(ticketAiState.ticketId, ticketId), sql`${ticketAiState.learnedAt} IS NULL`))
    .returning({ id: ticketAiState.ticketId })
    .get();
  return Boolean(row);
}

// --- Daily usage -----------------------------------------------------------------------------

/** The UTC day key, the same as the stats tables use. */
export function usageDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export type UsageCounter = "replies" | "background" | "escalations" | "resolved";

export function getUsage(guildId: string, day = usageDay()): Record<UsageCounter, number> {
  const row = getDb()
    .select()
    .from(ticketAiUsageDaily)
    .where(and(eq(ticketAiUsageDaily.guildId, guildId), eq(ticketAiUsageDaily.statDate, day)))
    .get();
  return {
    replies: row?.replies ?? 0,
    background: row?.background ?? 0,
    escalations: row?.escalations ?? 0,
    resolved: row?.resolved ?? 0,
  };
}

/**
 * Takes one unit of today's `counter` if it's still under `limit`, in a single conditional upsert,
 * so concurrent tickets can never overshoot the limit. Returns whether it was taken.
 */
export function takeUsage(guildId: string, counter: "replies" | "background", limit: number, day = usageDay()): boolean {
  const column = counter === "replies" ? ticketAiUsageDaily.replies : ticketAiUsageDaily.background;
  return getDb().transaction((tx) => {
    const row = tx
      .select({ used: column })
      .from(ticketAiUsageDaily)
      .where(and(eq(ticketAiUsageDaily.guildId, guildId), eq(ticketAiUsageDaily.statDate, day)))
      .get();
    if ((row?.used ?? 0) >= limit) return false;
    tx.insert(ticketAiUsageDaily)
      .values({ guildId, statDate: day, [counter]: 1 })
      .onConflictDoUpdate({
        target: [ticketAiUsageDaily.guildId, ticketAiUsageDaily.statDate],
        set: { [counter]: sql`${column} + 1` },
      })
      .run();
    return true;
  });
}

/** Gives back a unit taken by takeUsage when the AI call then failed (the member got nothing). */
export function refundUsage(guildId: string, counter: "replies" | "background", day = usageDay()): void {
  const column = counter === "replies" ? ticketAiUsageDaily.replies : ticketAiUsageDaily.background;
  getDb()
    .update(ticketAiUsageDaily)
    .set({ [counter]: sql`max(0, ${column} - 1)` })
    .where(and(eq(ticketAiUsageDaily.guildId, guildId), eq(ticketAiUsageDaily.statDate, day)))
    .run();
}

export function bumpUsage(guildId: string, counter: "escalations" | "resolved", day = usageDay()): void {
  const column = counter === "escalations" ? ticketAiUsageDaily.escalations : ticketAiUsageDaily.resolved;
  getDb()
    .insert(ticketAiUsageDaily)
    .values({ guildId, statDate: day, [counter]: 1 })
    .onConflictDoUpdate({
      target: [ticketAiUsageDaily.guildId, ticketAiUsageDaily.statDate],
      set: { [counter]: sql`${column} + 1` },
    })
    .run();
}

/** Daily usage over the last `days` days (oldest first), for the dashboard chart. */
export function usageHistory(guildId: string, days: number): Array<{ day: string } & Record<UsageCounter, number>> {
  const out: Array<{ day: string } & Record<UsageCounter, number>> = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const day = usageDay(date);
    out.push({ day, ...getUsage(guildId, day) });
  }
  return out;
}

// --- Per-guild state -------------------------------------------------------------------------

export type AutotrainResult = {
  ok: boolean;
  channels: number;
  messagesRead: number;
  factsAdded: number;
  factsUpdated: number;
  error?: string;
};

export function getAutotrainState(guildId: string): { lastRunAt: Date | null; lastResult: AutotrainResult | null } {
  const row = getDb().select().from(ticketAiGuildState).where(eq(ticketAiGuildState.guildId, guildId)).get();
  let lastResult: AutotrainResult | null = null;
  try {
    lastResult = row?.autotrainLastResult ? (JSON.parse(row.autotrainLastResult) as AutotrainResult) : null;
  } catch {
    lastResult = null;
  }
  return { lastRunAt: row?.autotrainLastRunAt ?? null, lastResult };
}

export function setAutotrainState(guildId: string, result: AutotrainResult): void {
  const now = new Date();
  getDb()
    .insert(ticketAiGuildState)
    .values({ guildId, autotrainLastRunAt: now, autotrainLastResult: JSON.stringify(result), updatedAt: now })
    .onConflictDoUpdate({
      target: ticketAiGuildState.guildId,
      set: { autotrainLastRunAt: now, autotrainLastResult: JSON.stringify(result), updatedAt: now },
    })
    .run();
}
