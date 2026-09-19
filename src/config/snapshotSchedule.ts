import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { guildSnapshotSchedules } from "../db/schema.js";
import { getLogger } from "../core/logger.js";
import { createSnapshot } from "./snapshots.js";

const log = getLogger("core");

/** Enforced both here and on the dashboard's input — automatic snapshots can't fire more often
 *  than this, so a misconfigured guild can't hammer the DB. */
export const MIN_SNAPSHOT_INTERVAL_MINUTES = 30;
export const MAX_SNAPSHOT_INTERVAL_MINUTES = 43_200; // 30 days

export type SnapshotSchedule = {
  guildId: string;
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt: Date | null;
  updatedBy: string | null;
  updatedAt: Date;
};

function clampInterval(minutes: number): number {
  return Math.min(MAX_SNAPSHOT_INTERVAL_MINUTES, Math.max(MIN_SNAPSHOT_INTERVAL_MINUTES, Math.round(minutes)));
}

export async function getSnapshotSchedule(guildId: string): Promise<SnapshotSchedule | null> {
  const row = await getDb()
    .select()
    .from(guildSnapshotSchedules)
    .where(eq(guildSnapshotSchedules.guildId, guildId))
    .get();
  return row ?? null;
}

/** Creates or updates a guild's automatic-snapshot schedule. A brand-new schedule's `lastRunAt`
 *  starts at "now" so it doesn't fire immediately; updating an existing schedule's interval
 *  leaves `lastRunAt` untouched so the next due time shifts naturally from the last real run. */
export async function setSnapshotSchedule(input: {
  guildId: string;
  intervalMinutes: number;
  enabled: boolean;
  updatedBy: string | null;
}): Promise<SnapshotSchedule> {
  const db = getDb();
  const intervalMinutes = clampInterval(input.intervalMinutes);
  const now = new Date();

  const existing = await getSnapshotSchedule(input.guildId);
  if (existing) {
    return db
      .update(guildSnapshotSchedules)
      .set({ intervalMinutes, enabled: input.enabled, updatedBy: input.updatedBy, updatedAt: now })
      .where(eq(guildSnapshotSchedules.guildId, input.guildId))
      .returning()
      .get();
  }

  return db
    .insert(guildSnapshotSchedules)
    .values({
      guildId: input.guildId,
      intervalMinutes,
      enabled: input.enabled,
      lastRunAt: now,
      updatedBy: input.updatedBy,
      updatedAt: now,
    })
    .returning()
    .get();
}

export async function clearSnapshotSchedule(guildId: string): Promise<void> {
  await getDb().delete(guildSnapshotSchedules).where(eq(guildSnapshotSchedules.guildId, guildId));
}

export async function markSnapshotScheduleRun(guildId: string, when: Date): Promise<void> {
  await getDb()
    .update(guildSnapshotSchedules)
    .set({ lastRunAt: when })
    .where(eq(guildSnapshotSchedules.guildId, guildId));
}

/** Schedules that are enabled and whose interval has elapsed since their last run. */
export async function listDueSnapshotSchedules(now: Date): Promise<SnapshotSchedule[]> {
  const rows = await getDb()
    .select()
    .from(guildSnapshotSchedules)
    .where(eq(guildSnapshotSchedules.enabled, true))
    .all();

  return rows.filter((row) => {
    if (!row.lastRunAt) return true;
    return now.getTime() - row.lastRunAt.getTime() >= row.intervalMinutes * 60_000;
  });
}

/** Sweep tick: takes an automatic snapshot for every guild whose schedule is due. Each guild is
 *  handled independently — one failure doesn't block the rest, and a failed guild's `lastRunAt`
 *  is left alone so the next tick retries it. */
export async function runDueSnapshotSchedules(): Promise<void> {
  const due = await listDueSnapshotSchedules(new Date());
  for (const schedule of due) {
    try {
      await createSnapshot({ guildId: schedule.guildId, label: null, reason: "auto", createdBy: null });
      await markSnapshotScheduleRun(schedule.guildId, new Date());
    } catch (error) {
      log.error(`Automatic snapshot failed for guild ${schedule.guildId}:`, error);
    }
  }
}
