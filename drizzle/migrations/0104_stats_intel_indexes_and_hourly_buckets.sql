CREATE INDEX IF NOT EXISTS `guild_stats_user_daily_guild_date` ON `guild_stats_user_daily` (`guild_id`,`stat_date`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `guild_stats_channel_daily_guild_date` ON `guild_stats_channel_daily` (`guild_id`,`stat_date`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `guild_stats_hourly_bucket` (
	`guild_id` text NOT NULL,
	`bucket_hour` text NOT NULL,
	`messages` integer DEFAULT 0 NOT NULL,
	`joins` integer DEFAULT 0 NOT NULL,
	`leaves` integer DEFAULT 0 NOT NULL,
	`edits` integer DEFAULT 0 NOT NULL,
	`deletes` integer DEFAULT 0 NOT NULL,
	`reactions` integer DEFAULT 0 NOT NULL,
	`attachments` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`guild_id`, `bucket_hour`)
);
