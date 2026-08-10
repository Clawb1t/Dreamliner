CREATE TABLE IF NOT EXISTS `automod_hits` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `rule_id` text NOT NULL,
  `channel_id` text,
  `message_id` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `automod_hits_guild_user_rule_created_idx`
  ON `automod_hits` (`guild_id`, `user_id`, `rule_id`, `created_at`);
