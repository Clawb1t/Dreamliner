CREATE TABLE IF NOT EXISTS `activity_rewards_progress` (
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `messages` integer DEFAULT 0 NOT NULL,
  `voice_seconds` integer DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`guild_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `activity_rewards_progress_guild_messages` ON `activity_rewards_progress` (`guild_id`, `messages`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `activity_rewards_progress_guild_voice` ON `activity_rewards_progress` (`guild_id`, `voice_seconds`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `activity_rewards_awarded` (
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `milestone_id` integer NOT NULL,
  `awarded_at` integer NOT NULL,
  PRIMARY KEY(`guild_id`, `user_id`, `milestone_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `welcome_member_milestones` (
  `guild_id` text NOT NULL,
  `member_count` integer NOT NULL,
  `reached_at` integer NOT NULL,
  PRIMARY KEY(`guild_id`, `member_count`)
);
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'activity_rewards.can_view' FROM `guild_permission_roles` WHERE `built_in` = 'member';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'activity_rewards.can_sync' FROM `guild_permission_roles` WHERE `built_in` = 'member';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'activity_rewards.can_manage' FROM `guild_permission_roles` WHERE `built_in` = 'admin';
