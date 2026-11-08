/** Server Autopilot persistence: generations, build/restore jobs and structure backups. */
import { and, desc, eq, inArray, lt, notInArray } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { serverAutopilotBackups, serverAutopilotBuilds, serverAutopilotGenerations } from "../../db/schema.js";
import { getLogger } from "../logger.js";
import { SA_LIMITS } from "./types.js";

const log = getLogger("server_autopilot");

export type GenerationRow = typeof serverAutopilotGenerations.$inferSelect;
export type BuildRow = typeof serverAutopilotBuilds.$inferSelect;
export type BackupRow = typeof serverAutopilotBackups.$inferSelect;

export const RESTART_MESSAGE = "Dreamliner restarted during the build — run it again; finished steps are kept";
const RESTART_GENERATION_MESSAGE = "Dreamliner restarted while generating. Please generate again.";

// ── Generations ─────────────────────────────────────────────────────────────

export function insertGeneration(values: { guildId: string; answers: string; charged: boolean; createdBy: string }): GenerationRow {
  const row = getDb()
    .insert(serverAutopilotGenerations)
    .values({ ...values, templates: "[]", status: "running", progress: 0, createdAt: new Date() })
    .returning()
    .get();
  pruneGenerations(values.guildId);
  return row;
}

export function getGeneration(guildId: string, id: number): GenerationRow | null {
  return (
    getDb()
      .select()
      .from(serverAutopilotGenerations)
      .where(and(eq(serverAutopilotGenerations.guildId, guildId), eq(serverAutopilotGenerations.id, id)))
      .get() ?? null
  );
}

export function updateGeneration(id: number, patch: Partial<Omit<GenerationRow, "id" | "guildId">>): void {
  getDb().update(serverAutopilotGenerations).set(patch).where(eq(serverAutopilotGenerations.id, id)).run();
}

export function listGenerations(guildId: string): GenerationRow[] {
  return getDb()
    .select()
    .from(serverAutopilotGenerations)
    .where(eq(serverAutopilotGenerations.guildId, guildId))
    .orderBy(desc(serverAutopilotGenerations.createdAt), desc(serverAutopilotGenerations.id))
    .limit(SA_LIMITS.generationsKept)
    .all();
}

export function runningGeneration(guildId: string): GenerationRow | null {
  return (
    getDb()
      .select()
      .from(serverAutopilotGenerations)
      .where(and(eq(serverAutopilotGenerations.guildId, guildId), eq(serverAutopilotGenerations.status, "running")))
      .get() ?? null
  );
}

function pruneGenerations(guildId: string): void {
  const keep = getDb()
    .select({ id: serverAutopilotGenerations.id })
    .from(serverAutopilotGenerations)
    .where(eq(serverAutopilotGenerations.guildId, guildId))
    .orderBy(desc(serverAutopilotGenerations.id))
    .limit(SA_LIMITS.generationsKept)
    .all()
    .map((r) => r.id);
  if (keep.length < SA_LIMITS.generationsKept) return;
  getDb()
    .delete(serverAutopilotGenerations)
    .where(and(eq(serverAutopilotGenerations.guildId, guildId), notInArray(serverAutopilotGenerations.id, keep)))
    .run();
}

// ── Builds ──────────────────────────────────────────────────────────────────

export function insertBuild(values: Omit<typeof serverAutopilotBuilds.$inferInsert, "id">): BuildRow {
  return getDb().insert(serverAutopilotBuilds).values(values).returning().get();
}

export function getBuild(guildId: string, id: number): BuildRow | null {
  return getDb().select().from(serverAutopilotBuilds).where(and(eq(serverAutopilotBuilds.guildId, guildId), eq(serverAutopilotBuilds.id, id))).get() ?? null;
}

export function updateBuild(id: number, patch: Partial<Omit<BuildRow, "id" | "guildId">>): void {
  getDb().update(serverAutopilotBuilds).set(patch).where(eq(serverAutopilotBuilds.id, id)).run();
}

export function cancelRequested(id: number): boolean {
  return Boolean(getDb().select({ c: serverAutopilotBuilds.cancelRequested }).from(serverAutopilotBuilds).where(eq(serverAutopilotBuilds.id, id)).get()?.c);
}

export function listBuilds(guildId: string, limit = 20): BuildRow[] {
  return getDb()
    .select()
    .from(serverAutopilotBuilds)
    .where(eq(serverAutopilotBuilds.guildId, guildId))
    .orderBy(desc(serverAutopilotBuilds.createdAt), desc(serverAutopilotBuilds.id))
    .limit(limit)
    .all();
}

export function activeBuild(guildId: string): BuildRow | null {
  return (
    getDb()
      .select()
      .from(serverAutopilotBuilds)
      .where(and(eq(serverAutopilotBuilds.guildId, guildId), inArray(serverAutopilotBuilds.status, ["queued", "running"])))
      .get() ?? null
  );
}

/** The newest earlier build of the same template that didn't finish, for resuming with its ids. */
export function lastUnfinishedBuild(guildId: string, templateId: string, beforeId: number): BuildRow | null {
  const rows = getDb()
    .select()
    .from(serverAutopilotBuilds)
    .where(and(eq(serverAutopilotBuilds.guildId, guildId), eq(serverAutopilotBuilds.kind, "build"), lt(serverAutopilotBuilds.id, beforeId)))
    .orderBy(desc(serverAutopilotBuilds.id))
    .limit(5)
    .all();
  for (const row of rows) {
    if (row.status !== "failed" && row.status !== "cancelled") continue;
    try {
      if ((JSON.parse(row.template ?? "{}") as { id?: string }).id === templateId) return row;
    } catch {
      /* unreadable row */
    }
  }
  return null;
}

// ── Backups ─────────────────────────────────────────────────────────────────

export function insertBackup(values: Omit<typeof serverAutopilotBackups.$inferInsert, "id">): BackupRow {
  const row = getDb().insert(serverAutopilotBackups).values(values).returning().get();
  pruneBackups(values.guildId);
  return row;
}

export function getBackup(guildId: string, id: number): BackupRow | null {
  return getDb().select().from(serverAutopilotBackups).where(and(eq(serverAutopilotBackups.guildId, guildId), eq(serverAutopilotBackups.id, id))).get() ?? null;
}

export function listBackups(guildId: string): Omit<BackupRow, "structure">[] {
  return getDb()
    .select({
      id: serverAutopilotBackups.id,
      guildId: serverAutopilotBackups.guildId,
      reason: serverAutopilotBackups.reason,
      roleCount: serverAutopilotBackups.roleCount,
      channelCount: serverAutopilotBackups.channelCount,
      configSnapshotId: serverAutopilotBackups.configSnapshotId,
      buildId: serverAutopilotBackups.buildId,
      createdBy: serverAutopilotBackups.createdBy,
      createdAt: serverAutopilotBackups.createdAt,
    })
    .from(serverAutopilotBackups)
    .where(eq(serverAutopilotBackups.guildId, guildId))
    .orderBy(desc(serverAutopilotBackups.createdAt), desc(serverAutopilotBackups.id))
    .all();
}

export function deleteBackup(guildId: string, id: number): boolean {
  return Boolean(getDb().delete(serverAutopilotBackups).where(and(eq(serverAutopilotBackups.guildId, guildId), eq(serverAutopilotBackups.id, id))).returning().get());
}

function pruneBackups(guildId: string): void {
  const keep = getDb()
    .select({ id: serverAutopilotBackups.id })
    .from(serverAutopilotBackups)
    .where(eq(serverAutopilotBackups.guildId, guildId))
    .orderBy(desc(serverAutopilotBackups.id))
    .limit(SA_LIMITS.backupsKept)
    .all()
    .map((r) => r.id);
  if (keep.length < SA_LIMITS.backupsKept) return;
  getDb().delete(serverAutopilotBackups).where(and(eq(serverAutopilotBackups.guildId, guildId), notInArray(serverAutopilotBackups.id, keep))).run();
}

// ── Restart safety ──────────────────────────────────────────────────────────

/**
 * On boot, nothing can still be running: jobs that were mid-way when the process stopped are
 * marked failed (builds keep their finished steps and created ids, so rerunning continues), and
 * generations that produced nothing give their free use back.
 */
export async function failInterruptedJobs(): Promise<void> {
  const db = getDb();
  const now = new Date();
  const builds = db.select().from(serverAutopilotBuilds).where(inArray(serverAutopilotBuilds.status, ["queued", "running"])).all();
  for (const build of builds) {
    let errors: Array<{ step: string; message: string }> = [];
    let steps: Array<{ status: string; note: string }> = [];
    try {
      errors = JSON.parse(build.errors);
      steps = JSON.parse(build.steps);
    } catch {
      /* keep defaults */
    }
    const running = steps.find((s) => s.status === "running") as ({ id?: string } & { status: string; note: string }) | undefined;
    for (const step of steps) {
      if (step.status === "running") {
        step.status = "failed";
        step.note = "Interrupted by a restart";
      } else if (step.status === "pending") step.status = "skipped";
    }
    errors.push({ step: running?.id ?? "build", message: RESTART_MESSAGE });
    db.update(serverAutopilotBuilds)
      .set({ status: "failed", steps: JSON.stringify(steps), errors: JSON.stringify(errors), finishedAt: now })
      .where(eq(serverAutopilotBuilds.id, build.id))
      .run();
  }
  const generations = db.select().from(serverAutopilotGenerations).where(eq(serverAutopilotGenerations.status, "running")).all();
  for (const generation of generations) {
    let templates: unknown[] = [];
    try {
      templates = JSON.parse(generation.templates) as unknown[];
    } catch {
      /* none */
    }
    db.update(serverAutopilotGenerations)
      .set({ status: templates.length ? "done" : "failed", error: templates.length ? null : RESTART_GENERATION_MESSAGE, progress: 3, finishedAt: now })
      .where(eq(serverAutopilotGenerations.id, generation.id))
      .run();
    if (!templates.length && generation.charged) {
      const { refundFreeAiUse } = await import("../ai/usage.js");
      await refundFreeAiUse(generation.guildId).catch(() => null);
    }
  }
  if (builds.length || generations.length) log.info(`[server_autopilot] Marked ${builds.length} build(s) and ${generations.length} generation(s) as interrupted.`);
}
