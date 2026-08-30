-- Economy plugin restored (global + server currency only — the Dreamliner
-- Exchange stock market from before is not coming back).
CREATE TABLE IF NOT EXISTS `economy_global_accounts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`balance` real DEFAULT 0 NOT NULL,
	`last_message_at` integer,
	`last_daily_at` integer,
	`daily_streak` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `economy_server_accounts` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`balance` real DEFAULT 0 NOT NULL,
	`last_message_at` integer,
	`last_daily_at` integer,
	`daily_streak` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`)
);
