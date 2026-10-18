CREATE INDEX IF NOT EXISTS `guild_message_counts_guild_count` ON `guild_message_counts` (`guild_id`, `count`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `user_message_counts_count` ON `user_message_counts` (`count`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `guild_stats_user_daily_user_date` ON `guild_stats_user_daily` (`user_id`, `stat_date`);
