CREATE TABLE `guild_user_trail` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `started_at` integer NOT NULL,
  `ended_at` integer NOT NULL,
  `message_count` integer NOT NULL DEFAULT 1,
  `snippet` text NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE INDEX `guild_user_trail_lookup` ON `guild_user_trail` (`guild_id`, `user_id`, `ended_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `log_messages_author_idx` ON `log_messages` (`guild_id`, `author_id`, `message_id`);
