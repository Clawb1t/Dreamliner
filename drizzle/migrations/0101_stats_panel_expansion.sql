CREATE TABLE IF NOT EXISTS `guild_stats_hourly` (
	`guild_id` text NOT NULL,
	`weekday_utc` integer NOT NULL,
	`hour_utc` integer NOT NULL,
	`messages` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`guild_id`, `weekday_utc`, `hour_utc`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `guild_stats_voice_daily` (
	`guild_id` text NOT NULL,
	`stat_date` text NOT NULL,
	`minutes` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`guild_id`, `stat_date`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `guild_stats_user_voice_daily` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`stat_date` text NOT NULL,
	`minutes` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`, `stat_date`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `guild_stats_channel_voice_daily` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`stat_date` text NOT NULL,
	`minutes` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`guild_id`, `channel_id`, `stat_date`)
);
