import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { guildConfigs, guildSnapshots } from "../db/schema.js";
import { loadDefaultConfig } from "./default.js";

/** How many snapshots a guild keeps before the oldest are pruned automatically. */
export const MAX_SNAPSHOTS_PER_GUILD = 25;

export type SnapshotReason = "manual" | "pre_rollback";

export type SnapshotRow = {
  id: number;
  guildId: string;
  label: string | null;
  reason: SnapshotReason;
  createdBy: string | null;
  createdAt: Date;
  configJson: string;
  userConfigJson: string | null;
};

function mapRow(row: {
  id: number;
  guildId: string;
  label: string | null;
  reason: string;
  createdBy: string | null;
  createdAt: Date;
  configJson: string;
  userConfigJson: string | null;
}): SnapshotRow {
  return {
    ...row,
    reason: row.reason === "pre_rollback" ? "pre_rollback" : "manual",
  };
}

/** Byte size of a snapshot's stored config, for display in the dashboard list. */
export function snapshotSizeBytes(row: SnapshotRow): number {
  return Buffer.byteLength(row.configJson, "utf8") + Buffer.byteLength(row.userConfigJson ?? "", "utf8");
}

async function insertSnapshot(input: {
  guildId: string;
  label: string | null;
  reason: SnapshotReason;
  createdBy: string | null;
  configJson: string;
  userConfigJson: string | null;
}): Promise<SnapshotRow> {
  const db = getDb();
  const inserted = await db
    .insert(guildSnapshots)
    .values({
      guildId: input.guildId,
      label: input.label,
      reason: input.reason,
      createdBy: input.createdBy,
      createdAt: new Date(),
      configJson: input.configJson,
      userConfigJson: input.userConfigJson,
    })
    .returning()
    .get();

  await pruneSnapshots(input.guildId, MAX_SNAPSHOTS_PER_GUILD);

  return mapRow(inserted);
}

/**
 * Captures the guild's config exactly as currently stored (or the shipped defaults, for a guild
 * that has never saved one) into a new snapshot row, then prunes anything beyond
 * `MAX_SNAPSHOTS_PER_GUILD`. Stores the whole config blob rather than per-plugin fields, so every
 * plugin's settings are captured automatically — nothing here needs to change when a new plugin
 * is added to the bot.
 */
export async function createSnapshot(input: {
  guildId: string;
  label: string | null;
  reason: SnapshotReason;
  createdBy: string | null;
}): Promise<SnapshotRow> {
  const current = await getDb()
    .select()
    .from(guildConfigs)
    .where(eq(guildConfigs.guildId, input.guildId))
    .get();

  return insertSnapshot({
    ...input,
    configJson: current?.configJson ?? JSON.stringify(loadDefaultConfig()),
    userConfigJson: current?.userConfigJson ?? null,
  });
}

/** Same as `createSnapshot`, but from already-validated config content (e.g. an uploaded file)
 *  rather than the guild's current live config. */
export async function createSnapshotFromConfig(input: {
  guildId: string;
  label: string | null;
  createdBy: string | null;
  configJson: string;
  userConfigJson: string | null;
}): Promise<SnapshotRow> {
  return insertSnapshot({ ...input, reason: "manual" });
}

export async function listSnapshots(guildId: string, limit = MAX_SNAPSHOTS_PER_GUILD): Promise<SnapshotRow[]> {
  const rows = await getDb()
    .select()
    .from(guildSnapshots)
    .where(eq(guildSnapshots.guildId, guildId))
    .orderBy(desc(guildSnapshots.createdAt))
    .limit(limit)
    .all();
  return rows.map(mapRow);
}

export async function getSnapshot(guildId: string, id: number): Promise<SnapshotRow | null> {
  const row = await getDb()
    .select()
    .from(guildSnapshots)
    .where(and(eq(guildSnapshots.guildId, guildId), eq(guildSnapshots.id, id)))
    .get();
  return row ? mapRow(row) : null;
}

export async function deleteSnapshot(guildId: string, id: number): Promise<boolean> {
  const deleted = await getDb()
    .delete(guildSnapshots)
    .where(and(eq(guildSnapshots.guildId, guildId), eq(guildSnapshots.id, id)))
    .returning()
    .get();
  return Boolean(deleted);
}

/** Deletes the oldest snapshots for a guild beyond the `keep` most recent. */
export async function pruneSnapshots(guildId: string, keep: number): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: guildSnapshots.id })
    .from(guildSnapshots)
    .where(eq(guildSnapshots.guildId, guildId))
    .orderBy(asc(guildSnapshots.createdAt))
    .all();

  const excess = rows.length - Math.max(1, keep);
  if (excess <= 0) return;

  const idsToDelete = rows.slice(0, excess).map((r) => r.id);
  for (const id of idsToDelete) {
    await db.delete(guildSnapshots).where(and(eq(guildSnapshots.guildId, guildId), eq(guildSnapshots.id, id)));
  }
}
