CREATE TABLE `member_identity` (
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `nickname` text NOT NULL DEFAULT '',
  `role_ids` text NOT NULL DEFAULT '[]',
  `timeout_until` integer,
  `username` text NOT NULL DEFAULT '',
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`guild_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `member_identity_user_idx` ON `member_identity` (`user_id`);
