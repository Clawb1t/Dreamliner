import YAML from "yaml";
import { configManager } from "./manager.js";
import { createSnapshot, getSnapshot, type SnapshotRow } from "./snapshots.js";

export type RollbackResult =
  | { ok: true; snapshot: SnapshotRow; safetySnapshot: SnapshotRow }
  | { ok: false; error: string };

/**
 * Restores a guild's config from a stored snapshot. Always saves a "pre_rollback" safety
 * snapshot of the current state first, so a rollback is itself always undoable. Goes through the
 * normal `saveGuildConfig` validate/repair/merge path (same as the dashboard's own Save button),
 * so obsolete fields from a since-removed plugin are stripped instead of blocking the rollback,
 * and a since-added plugin just keeps its defaults.
 */
export async function rollbackToSnapshot(
  guildId: string,
  snapshotId: number,
  actorId: string,
): Promise<RollbackResult> {
  const snapshot = await getSnapshot(guildId, snapshotId);
  if (!snapshot) return { ok: false, error: "That snapshot no longer exists." };

  const safetySnapshot = await createSnapshot({
    guildId,
    label: `Before rollback to #${snapshot.id}`,
    reason: "pre_rollback",
    createdBy: actorId,
  });

  const userOverrides = snapshot.userConfigJson ? (JSON.parse(snapshot.userConfigJson) as Record<string, unknown>) : {};
  const yaml = YAML.stringify(userOverrides);
  const result = await configManager.saveGuildConfig(guildId, yaml, `system:snapshot-rollback:${actorId}`);
  if (!result.success) {
    return { ok: false, error: result.errors.join("\n") };
  }

  return { ok: true, snapshot, safetySnapshot };
}
