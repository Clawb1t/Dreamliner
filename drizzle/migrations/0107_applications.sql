CREATE TABLE IF NOT EXISTS `applications` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `opening_id` text NOT NULL,
  `opening_name` text NOT NULL,
  `user_id` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `answers_json` text NOT NULL,
  `review_channel_id` text,
  `review_message_id` text,
  `thread_id` text,
  `reviewer_id` text,
  `reason` text,
  `created_at` integer NOT NULL,
  `decided_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `applications_guild_status` ON `applications` (`guild_id`, `status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `applications_guild_user` ON `applications` (`guild_id`, `user_id`, `opening_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'applications.can_review' FROM `guild_permission_roles` WHERE `built_in` = 'moderator';
