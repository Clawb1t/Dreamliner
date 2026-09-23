CREATE TABLE IF NOT EXISTS `image_daily_sends` (
  `guild_id` text NOT NULL,
  `send_id` integer NOT NULL,
  `last_sent_date` text NOT NULL,
  `last_sent_at` integer NOT NULL,
  PRIMARY KEY(`guild_id`, `send_id`)
);
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'images.can_use' FROM `guild_permission_roles` WHERE `built_in` = 'member';
