CREATE TABLE `passport_pending` (
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `joined_at` integer NOT NULL,
  `expires_at` integer,
  `ping_message_id` text,
  `ping_channel_id` text,
  `status` text NOT NULL DEFAULT 'pending',
  PRIMARY KEY (`guild_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `passport_pending_expires_idx` ON `passport_pending` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `passport_verifications` (
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `verified_at` integer NOT NULL,
  `method` text NOT NULL DEFAULT 'web',
  `account_created_at` integer,
  PRIMARY KEY (`guild_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `passport_verifications_user_idx` ON `passport_verifications` (`user_id`);
