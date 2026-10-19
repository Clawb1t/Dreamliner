DROP INDEX IF EXISTS `guild_stats_user_daily_user_date`;
--> statement-breakpoint
CREATE INDEX `guild_stats_user_daily_user_date` ON `guild_stats_user_daily` (`user_id`, `stat_date`, `messages`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `guild_stats_user_daily_date_user` ON `guild_stats_user_daily` (`stat_date`, `user_id`, `messages`);
