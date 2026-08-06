CREATE TABLE `dream_commands` (
	`guild_id` text NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`min_level` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`guild_id`, `name`)
);
