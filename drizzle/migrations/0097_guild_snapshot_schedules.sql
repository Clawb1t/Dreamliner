CREATE TABLE IF NOT EXISTS `guild_snapshot_schedules` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`interval_minutes` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` integer,
	`updated_by` text,
	`updated_at` integer NOT NULL
);
