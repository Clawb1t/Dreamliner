CREATE TABLE IF NOT EXISTS `guild_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`label` text,
	`reason` text DEFAULT 'manual' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`config_json` text NOT NULL,
	`user_config_json` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `guild_snapshots_guild_created` ON `guild_snapshots` (`guild_id`,`created_at`);
