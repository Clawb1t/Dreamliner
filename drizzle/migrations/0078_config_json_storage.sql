-- guild_configs moves from YAML-text columns to JSON-text columns. This migration only renames
-- the columns (SQLite's ALTER TABLE ... RENAME COLUMN is a metadata-only change — no data is
-- touched or reformatted here). Existing rows still hold YAML text under the new names until
-- src/scripts/migrateConfigStorageToJson.ts (run once at boot, before ConfigManager is used)
-- converts each row's content to JSON in place. That script is idempotent — it JSON.parses first
-- and skips rows that are already migrated.
ALTER TABLE guild_configs RENAME COLUMN config_yaml TO config_json;
--> statement-breakpoint
ALTER TABLE guild_configs RENAME COLUMN user_config_yaml TO user_config_json;
--> statement-breakpoint
ALTER TABLE guild_configs RENAME COLUMN defaults_snapshot_yaml TO defaults_snapshot_json;
