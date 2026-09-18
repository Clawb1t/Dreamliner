CREATE INDEX IF NOT EXISTS `message_archives_guild` ON `message_archives` (`guild_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mod_cases_guild` ON `mod_cases` (`guild_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mod_cases_guild_user` ON `mod_cases` (`guild_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `reminders_guild` ON `reminders` (`guild_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `reminders_user` ON `reminders` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `guild_log_events_guild_created` ON `guild_log_events` (`guild_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `bot_avatar_requests_guild` ON `bot_avatar_requests` (`guild_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `reviews_guild` ON `reviews` (`guild_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suggestions_guild_number` ON `suggestions` (`guild_id`,`suggestion_number`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `guild_custom_charts_guild` ON `guild_custom_charts` (`guild_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `automod_hits_guild_user` ON `automod_hits` (`guild_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tickets_guild` ON `tickets` (`guild_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ticket_transcripts_guild` ON `ticket_transcripts` (`guild_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `social_youtube_watchers_guild` ON `social_youtube_watchers` (`guild_id`);
