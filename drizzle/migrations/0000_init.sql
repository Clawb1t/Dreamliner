CREATE TABLE `guild_configs` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`config_yaml` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `message_archives` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mod_cases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`mod_id` text NOT NULL,
	`type` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL
);
