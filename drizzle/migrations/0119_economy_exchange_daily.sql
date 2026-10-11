CREATE TABLE `economy_exchange_daily` (
  `user_id` text NOT NULL,
  `stat_date` text NOT NULL,
  `global_amount` real NOT NULL DEFAULT 0,
  PRIMARY KEY(`user_id`, `stat_date`)
);
--> statement-breakpoint
CREATE TABLE `starboard_bonus_paid` (
  `guild_id` text NOT NULL,
  `board_name` text NOT NULL,
  `source_message_id` text NOT NULL,
  `paid_at` integer NOT NULL,
  PRIMARY KEY(`guild_id`, `board_name`, `source_message_id`)
);
