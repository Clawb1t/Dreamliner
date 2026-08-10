CREATE TABLE IF NOT EXISTS `welcome_join_messages` (
  `message_id` text PRIMARY KEY NOT NULL,
  `guild_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `member_id` text NOT NULL,
  `created_at` integer NOT NULL,
  `wave_enabled` integer DEFAULT 0 NOT NULL,
  `wave_count` integer DEFAULT 0 NOT NULL,
  `waver_ids` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `welcome_join_messages_guild_member_idx`
  ON `welcome_join_messages` (`guild_id`, `member_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `welcome_join_messages_created_idx`
  ON `welcome_join_messages` (`created_at`);
