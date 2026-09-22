ALTER TABLE `guild_stats_voice_daily` ADD COLUMN `seconds` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `guild_stats_voice_daily` ADD COLUMN `sessions` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `guild_stats_voice_daily` ADD COLUMN `peak_concurrent` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `guild_stats_user_voice_daily` ADD COLUMN `seconds` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `guild_stats_user_voice_daily` ADD COLUMN `sessions` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `guild_stats_user_voice_daily` ADD COLUMN `muted_seconds` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `guild_stats_user_voice_daily` ADD COLUMN `deafened_seconds` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `guild_stats_user_voice_daily` ADD COLUMN `streaming_seconds` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `guild_stats_channel_voice_daily` ADD COLUMN `seconds` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `guild_stats_channel_voice_daily` ADD COLUMN `sessions` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `guild_stats_channel_voice_daily` ADD COLUMN `peak_concurrent` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `guild_stats_voice_hourly` (
	`guild_id` text NOT NULL,
	`weekday_utc` integer NOT NULL,
	`hour_utc` integer NOT NULL,
	`minutes` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`guild_id`, `weekday_utc`, `hour_utc`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `voice_active_sessions` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`)
);
