-- Server Files: one image library per server (src/core/serverFiles/).
--
-- Every image a server uploads from the dashboard lands here, and the older per-feature stores
-- (Message Kits images, Welcomer card backgrounds, Passport / Appeals / Team Control kiosk page
-- backgrounds, Character avatars) are indexed here too, pointing at their existing files on disk,
-- so their old links keep working and nothing is copied. Bytes live on disk under
-- data/guild-assets/<guild_id>/<storage>; this table is the index.
--
-- Where a file is used is worked out on demand (src/core/serverFiles/references.ts), not stored.

CREATE TABLE IF NOT EXISTS `server_files` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`display_name` text NOT NULL,
	`original_name` text NOT NULL,
	`content_type` text NOT NULL,
	`extension` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`frames` integer DEFAULT 1 NOT NULL,
	`sha256` text NOT NULL,
	`folder` text,
	`storage` text NOT NULL,
	`source` text DEFAULT 'upload' NOT NULL,
	`legacy_ref` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_used_at` integer
);
CREATE INDEX IF NOT EXISTS `server_files_guild` ON `server_files` (`guild_id`, `created_at`);
CREATE UNIQUE INDEX IF NOT EXISTS `server_files_storage` ON `server_files` (`guild_id`, `storage`);
CREATE INDEX IF NOT EXISTS `server_files_hash` ON `server_files` (`guild_id`, `sha256`);
