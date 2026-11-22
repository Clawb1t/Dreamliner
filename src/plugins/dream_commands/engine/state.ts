/**
 * Database-backed run state: run history (last 50 per command), follow-ups (buttons, menus and
 * forms a run posted, keyed by a random id in the custom id, with an expiry and a per-server
 * cap) and paused runs (long Wait steps, resumed by a poll, so a restart doesn't drop them).
 */
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { getDb } from "../../../db/client.js";
import { dreamCommandFollowups, dreamCommandJobs, dreamCommandRuns } from "../../../db/schema.js";
import type { Continuation, FollowupState } from "./interpreter.js";
import { LIMITS } from "./types.js";

// ── Runs ────────────────────────────────────────────────────────────────────────────────────

export type RunStatus = "ok" | "error" | "refused" | "stopped" | "waiting";
export type RunRecord = {
  id: number;
  guildId: string;
  commandName: string;
  userId: string;
  channelId: string | null;
  trigger: string;
  status: RunStatus;
  startedAt: Date;
  durationMs: number;
  steps: number;
  failedStepId: string | null;
  error: string | null;
};

export function recordRun(input: Omit<RunRecord, "id">): void {
  const db = getDb();
  db.insert(dreamCommandRuns)
    .values({ ...input, error: input.error?.slice(0, 500) ?? null })
    .run();
  // Keep the newest LIMITS.runHistory rows per command.
  const cutoff = db
    .select({ id: dreamCommandRuns.id })
    .from(dreamCommandRuns)
    .where(and(eq(dreamCommandRuns.guildId, input.guildId), eq(dreamCommandRuns.commandName, input.commandName)))
    .orderBy(desc(dreamCommandRuns.id))
    .limit(1)
    .offset(LIMITS.runHistory)
    .get();
  if (cutoff) {
    db.delete(dreamCommandRuns)
      .where(and(eq(dreamCommandRuns.guildId, input.guildId), eq(dreamCommandRuns.commandName, input.commandName), lte(dreamCommandRuns.id, cutoff.id)))
      .run();
  }
}

export function listRuns(guildId: string, commandName: string, limit: number = LIMITS.runHistory): RunRecord[] {
  return getDb()
    .select()
    .from(dreamCommandRuns)
    .where(and(eq(dreamCommandRuns.guildId, guildId), eq(dreamCommandRuns.commandName, commandName)))
    .orderBy(desc(dreamCommandRuns.id))
    .limit(limit)
    .all() as RunRecord[];
}

export type RunSummary = { runs30d: number; failures30d: number; last: { at: Date; status: RunStatus; error: string | null } | null };

export function summarizeRuns(guildId: string): Map<string, RunSummary> {
  const since = new Date(Date.now() - 30 * 86400_000);
  const rows = getDb()
    .select({
      name: dreamCommandRuns.commandName,
      runs: sql<number>`count(*)`,
      failures: sql<number>`sum(case when ${dreamCommandRuns.status} = 'error' then 1 else 0 end)`,
    })
    .from(dreamCommandRuns)
    .where(and(eq(dreamCommandRuns.guildId, guildId), gte(dreamCommandRuns.startedAt, since)))
    .groupBy(dreamCommandRuns.commandName)
    .all();
  const out = new Map<string, RunSummary>();
  for (const r of rows) out.set(r.name, { runs30d: Number(r.runs) || 0, failures30d: Number(r.failures) || 0, last: null });
  const latest = getDb()
    .select()
    .from(dreamCommandRuns)
    .where(eq(dreamCommandRuns.guildId, guildId))
    .orderBy(desc(dreamCommandRuns.id))
    .limit(500)
    .all();
  for (const r of latest) {
    const entry = out.get(r.commandName) ?? { runs30d: 0, failures30d: 0, last: null };
    if (!entry.last) entry.last = { at: r.startedAt, status: r.status as RunStatus, error: r.error };
    out.set(r.commandName, entry);
  }
  return out;
}

export function renameRuns(guildId: string, from: string, to: string): void {
  getDb().update(dreamCommandRuns).set({ commandName: to }).where(and(eq(dreamCommandRuns.guildId, guildId), eq(dreamCommandRuns.commandName, from))).run();
}

export function deleteCommandState(guildId: string, name: string): void {
  const db = getDb();
  db.delete(dreamCommandRuns).where(and(eq(dreamCommandRuns.guildId, guildId), eq(dreamCommandRuns.commandName, name))).run();
  db.delete(dreamCommandFollowups).where(and(eq(dreamCommandFollowups.guildId, guildId), eq(dreamCommandFollowups.commandName, name))).run();
  db.delete(dreamCommandJobs).where(and(eq(dreamCommandJobs.guildId, guildId), eq(dreamCommandJobs.commandName, name))).run();
}

// ── Follow-ups ──────────────────────────────────────────────────────────────────────────────

export type FollowupRow = {
  id: string;
  guildId: string;
  commandName: string;
  kind: string;
  messageId: string | null;
  state: FollowupState;
  uses: number;
  createdAt: Date;
  expiresAt: Date;
};

export function newFollowupId(): string {
  return randomBytes(9).toString("base64url");
}

export function saveFollowup(guildId: string, commandName: string, state: FollowupState, ttlMs: number, now = Date.now()): string {
  const db = getDb();
  // Per-server cap: drop the oldest when full.
  const count = Number(
    db.select({ n: sql<number>`count(*)` }).from(dreamCommandFollowups).where(eq(dreamCommandFollowups.guildId, guildId)).get()?.n ?? 0,
  );
  if (count >= LIMITS.followupsPerGuild) {
    const oldest = db
      .select({ id: dreamCommandFollowups.id })
      .from(dreamCommandFollowups)
      .where(eq(dreamCommandFollowups.guildId, guildId))
      .orderBy(asc(dreamCommandFollowups.createdAt))
      .limit(count - LIMITS.followupsPerGuild + 1)
      .all();
    for (const row of oldest) db.delete(dreamCommandFollowups).where(eq(dreamCommandFollowups.id, row.id)).run();
  }
  const id = newFollowupId();
  db.insert(dreamCommandFollowups)
    .values({ id, guildId, commandName, kind: state.kind, messageId: null, state: JSON.stringify(state), uses: 0, createdAt: new Date(now), expiresAt: new Date(now + ttlMs) })
    .run();
  return id;
}

export function attachFollowupMessage(id: string, messageId: string): void {
  getDb().update(dreamCommandFollowups).set({ messageId }).where(eq(dreamCommandFollowups.id, id)).run();
}

export type FollowupLookup = { status: "ok"; row: FollowupRow } | { status: "expired" } | { status: "missing" };

/** Looks a follow-up up for THIS guild only; expired rows are reported (and removed). */
export function getFollowup(id: string, guildId: string, now = Date.now()): FollowupLookup {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return { status: "missing" };
  const row = getDb()
    .select()
    .from(dreamCommandFollowups)
    .where(and(eq(dreamCommandFollowups.id, id), eq(dreamCommandFollowups.guildId, guildId)))
    .get();
  if (!row) return { status: "missing" };
  if (row.expiresAt.getTime() <= now) {
    getDb().delete(dreamCommandFollowups).where(eq(dreamCommandFollowups.id, id)).run();
    return { status: "expired" };
  }
  let state: FollowupState;
  try {
    state = JSON.parse(row.state) as FollowupState;
  } catch {
    return { status: "missing" };
  }
  return { status: "ok", row: { ...row, state } };
}

/** Counts a use; for single-use follow-ups only the first caller wins. */
export function claimFollowup(id: string, singleUse: boolean): boolean {
  const db = getDb();
  if (singleUse) {
    const res = db.update(dreamCommandFollowups).set({ uses: sql`${dreamCommandFollowups.uses} + 1` }).where(and(eq(dreamCommandFollowups.id, id), eq(dreamCommandFollowups.uses, 0))).run();
    return res.changes > 0;
  }
  db.update(dreamCommandFollowups).set({ uses: sql`${dreamCommandFollowups.uses} + 1` }).where(eq(dreamCommandFollowups.id, id)).run();
  return true;
}

export function deleteFollowup(id: string): void {
  getDb().delete(dreamCommandFollowups).where(eq(dreamCommandFollowups.id, id)).run();
}

export function pruneFollowups(now = Date.now()): number {
  return getDb().delete(dreamCommandFollowups).where(lt(dreamCommandFollowups.expiresAt, new Date(now))).run().changes;
}

// ── Paused runs ─────────────────────────────────────────────────────────────────────────────

export type JobState = {
  runnerId: string;
  channelId: string;
  builderId: string;
  trigger: string;
  startedAt: number;
  commandUpdatedAt: number;
  token: { applicationId: string; token: string; expiresAt: number } | null;
  continuation: Continuation;
};

export function saveJob(guildId: string, commandName: string, state: JobState, resumeAt: number): void {
  getDb()
    .insert(dreamCommandJobs)
    .values({ guildId, commandName, resumeAt: new Date(resumeAt), state: JSON.stringify(state), createdAt: new Date() })
    .run();
}

/** Takes (and deletes) due jobs, at most `limit` at a time. */
export function takeDueJobs(limit = 20, now = Date.now()): Array<{ id: number; guildId: string; commandName: string; state: JobState }> {
  const db = getDb();
  const rows = db.select().from(dreamCommandJobs).where(lte(dreamCommandJobs.resumeAt, new Date(now))).orderBy(asc(dreamCommandJobs.resumeAt)).limit(limit).all();
  const out: Array<{ id: number; guildId: string; commandName: string; state: JobState }> = [];
  for (const row of rows) {
    const res = db.delete(dreamCommandJobs).where(eq(dreamCommandJobs.id, row.id)).run();
    if (!res.changes) continue;
    try {
      out.push({ id: row.id, guildId: row.guildId, commandName: row.commandName, state: JSON.parse(row.state) as JobState });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

export function countJobs(guildId: string): number {
  return Number(getDb().select({ n: sql<number>`count(*)` }).from(dreamCommandJobs).where(eq(dreamCommandJobs.guildId, guildId)).get()?.n ?? 0);
}
