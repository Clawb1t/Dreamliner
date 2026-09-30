CREATE TABLE `progression_badges` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `key` text NOT NULL,
  `name` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `metric` text NOT NULL,
  `enabled` integer NOT NULL DEFAULT 1,
  `display_order` integer NOT NULL DEFAULT 0,
  `created_by` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `progression_badges_key` ON `progression_badges` (`key`);
--> statement-breakpoint
CREATE TABLE `progression_badge_tiers` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `badge_id` integer NOT NULL,
  `position` integer NOT NULL,
  `threshold` integer NOT NULL DEFAULT 0,
  `name` text NOT NULL DEFAULT '',
  `image` blob NOT NULL,
  `content_type` text NOT NULL,
  `image_version` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `progression_badge_tiers_badge_position` ON `progression_badge_tiers` (`badge_id`, `position`);
--> statement-breakpoint
CREATE TABLE `user_progression_badge_grants` (
  `user_id` text NOT NULL,
  `badge_key` text NOT NULL,
  `tier` integer,
  `granted_by` text NOT NULL,
  `granted_at` integer NOT NULL,
  PRIMARY KEY(`user_id`, `badge_key`)
);
--> statement-breakpoint
CREATE INDEX `user_progression_badge_grants_badge` ON `user_progression_badge_grants` (`badge_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `guild_message_counts_user` ON `guild_message_counts` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `guild_stats_user_voice_daily_user` ON `guild_stats_user_voice_daily` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suggestions_author` ON `suggestions` (`author_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `reviews_user` ON `reviews` (`user_id`);
