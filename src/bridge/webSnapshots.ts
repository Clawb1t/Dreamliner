import {
  createSnapshot,
  createSnapshotFromConfig,
  deleteSnapshot,
  getSnapshot,
  listSnapshots,
  snapshotSizeBytes,
  type SnapshotRow,
} from "../config/snapshots.js";
import { rollbackToSnapshot, type RollbackResult } from "../config/snapshotRollback.js";
import { computeUserOverrides, validateGuildConfig } from "../config/validator.js";
import { loadDefaultConfig } from "../config/default.js";
import {
  clearSnapshotSchedule,
  getSnapshotSchedule,
  MAX_SNAPSHOT_INTERVAL_MINUTES,
  MIN_SNAPSHOT_INTERVAL_MINUTES,
  setSnapshotSchedule,
  type SnapshotSchedule,
} from "../config/snapshotSchedule.js";

/** Uploaded snapshot files are tiny JSON config exports — anything bigger than this is rejected
 *  outright, before it's even parsed. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export type SnapshotView = {
  id: number;
  label: string | null;
  reason: SnapshotRow["reason"];
  createdBy: string | null;
  createdAt: string;
  sizeBytes: number;
};

function toView(row: SnapshotRow): SnapshotView {
  return {
    id: row.id,
    label: row.label,
    reason: row.reason,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    sizeBytes: snapshotSizeBytes(row),
  };
}

export async function listWebSnapshots(guildId: string): Promise<SnapshotView[]> {
  const rows = await listSnapshots(guildId);
  return rows.map(toView);
}

export async function createWebSnapshot(guildId: string, userId: string, label: string | null): Promise<SnapshotView> {
  const row = await createSnapshot({ guildId, label, reason: "manual", createdBy: userId });
  return toView(row);
}

export async function deleteWebSnapshot(guildId: string, id: number): Promise<boolean> {
  return deleteSnapshot(guildId, id);
}

export async function rollbackWebSnapshot(
  guildId: string,
  id: number,
  userId: string,
): Promise<{ ok: true; snapshot: SnapshotView; safetySnapshot: SnapshotView } | { ok: false; error: string }> {
  const result: RollbackResult = await rollbackToSnapshot(guildId, id, userId);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, snapshot: toView(result.snapshot), safetySnapshot: toView(result.safetySnapshot) };
}

/** The snapshot's full config, pretty-printed, for the dashboard's download button. */
export async function getWebSnapshotConfig(guildId: string, id: number): Promise<string | null> {
  const row = await getSnapshot(guildId, id);
  if (!row) return null;
  try {
    return JSON.stringify(JSON.parse(row.configJson), null, 2);
  } catch {
    return row.configJson;
  }
}

/**
 * Imports an uploaded config export as a new snapshot. Never trusts the file beyond parsing it
 * as plain JSON (no YAML/JS execution) and running it through the exact same validate-and-repair
 * pipeline every other config save goes through (`validateGuildConfig` with `repair: true`) —
 * unknown/obsolete/malformed fields are stripped rather than stored verbatim, so a corrupted or
 * hand-edited file can't smuggle anything past the schema.
 */
export async function importWebSnapshot(
  guildId: string,
  userId: string,
  label: string | null,
  rawConfigJson: string,
): Promise<{ ok: true; snapshot: SnapshotView } | { ok: false; error: string }> {
  if (Buffer.byteLength(rawConfigJson, "utf8") > MAX_UPLOAD_BYTES) {
    return { ok: false, error: "That file is too large (2MB max)." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfigJson);
  } catch {
    return { ok: false, error: "That file isn't valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "That doesn't look like a Dreamliner snapshot export." };
  }

  const validated = validateGuildConfig(parsed, { repair: true });
  if (!validated.success) {
    return { ok: false, error: validated.errors[0] ?? "That file isn't a valid Dreamliner configuration." };
  }

  const defaults = loadDefaultConfig() as unknown as Record<string, unknown>;
  const userOverrides = computeUserOverrides(validated.data as unknown as Record<string, unknown>, defaults);

  const row = await createSnapshotFromConfig({
    guildId,
    label,
    createdBy: userId,
    configJson: JSON.stringify(validated.data),
    userConfigJson: JSON.stringify(userOverrides),
  });

  return { ok: true, snapshot: toView(row) };
}

export type SnapshotScheduleView = {
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt: string | null;
};

function scheduleToView(row: SnapshotSchedule): SnapshotScheduleView {
  return { intervalMinutes: row.intervalMinutes, enabled: row.enabled, lastRunAt: row.lastRunAt?.toISOString() ?? null };
}

export async function getWebSnapshotSchedule(guildId: string): Promise<SnapshotScheduleView | null> {
  const row = await getSnapshotSchedule(guildId);
  return row ? scheduleToView(row) : null;
}

export async function setWebSnapshotSchedule(
  guildId: string,
  userId: string,
  intervalMinutes: number,
  enabled: boolean,
): Promise<{ ok: true; schedule: SnapshotScheduleView } | { ok: false; error: string }> {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < MIN_SNAPSHOT_INTERVAL_MINUTES) {
    return { ok: false, error: `Automatic snapshots can't run more often than every ${MIN_SNAPSHOT_INTERVAL_MINUTES} minutes.` };
  }
  if (intervalMinutes > MAX_SNAPSHOT_INTERVAL_MINUTES) {
    return { ok: false, error: "That interval is too long." };
  }

  const row = await setSnapshotSchedule({ guildId, intervalMinutes, enabled, updatedBy: userId });
  return { ok: true, schedule: scheduleToView(row) };
}

export async function deleteWebSnapshotSchedule(guildId: string): Promise<void> {
  await clearSnapshotSchedule(guildId);
}
