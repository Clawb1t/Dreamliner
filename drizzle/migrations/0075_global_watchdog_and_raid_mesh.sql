CREATE TABLE IF NOT EXISTS `global_watchdog_entries` (
	`user_id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`evidence_url` text,
	`added_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `raid_mesh_links` (
	`guild_id` text NOT NULL,
	`linked_guild_id` text NOT NULL,
	`linked_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `linked_guild_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `raid_mesh_invites` (
	`code` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
