import YAML from "yaml";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { guildConfigs } from "../db/schema.js";
import { getLogger } from "../core/logger.js";
const log = getLogger("scripts");

// One-time, idempotent migration: guild_configs' three content columns (config_json,
// user_config_json, defaults_snapshot_json — renamed from *_yaml by drizzle/migrations/
// 0078_config_json_storage.sql) still hold YAML text right after that rename, since a column
// rename doesn't touch data. This re-encodes each row's content as JSON in place.
//
// Must run at boot before anything reads guild config — ConfigManager (JSON.parse) and
// migratePermissionRoles.ts (reads config_json directly) both assume JSON from here on.
//
// Per row, per column: try JSON.parse first — if that succeeds, the row is already migrated
// (safe to run every boot, e.g. after a restart mid-migration). Otherwise YAML.parse the
// existing text and JSON.stringify it back. Never drops data, only re-encodes it.

function reencode(value: string | null): { text: string | null; changed: boolean } {
  if (value == null) return { text: value, changed: false };
  try {
    JSON.parse(value);
    return { text: value, changed: false }; // already JSON
  } catch {
    // fall through to YAML parse below
  }
  const parsed = YAML.parse(value);
  return { text: JSON.stringify(parsed ?? null), changed: true };
}

export function migrateConfigStorageToJson(): void {
  const db = getDb();
  const rows = db.select().from(guildConfigs).all();
  let migrated = 0;

  for (const row of rows) {
    try {
      const config = reencode(row.configJson);
      const userConfig = reencode(row.userConfigJson);
      const defaultsSnapshot = reencode(row.defaultsSnapshotJson);
      if (!config.changed && !userConfig.changed && !defaultsSnapshot.changed) continue;

      db.update(guildConfigs)
        .set({
          configJson: config.text ?? row.configJson,
          userConfigJson: userConfig.text,
          defaultsSnapshotJson: defaultsSnapshot.text,
        })
        .where(eq(guildConfigs.guildId, row.guildId))
        .run();
      migrated++;
    } catch (err) {
      log.error(`Config storage migration (YAML -> JSON) failed for guild ${row.guildId}:`, err);
    }
  }

  if (migrated > 0) {
    log.success(`Converted ${migrated} guild config row(s) from YAML to JSON storage.`);
  }
}
