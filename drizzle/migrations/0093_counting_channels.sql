CREATE TABLE `counting_channels` (
  `guild_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `current_count` integer DEFAULT 0 NOT NULL,
  `last_user_id` text,
  `last_message_id` text,
  `highest_count` integer DEFAULT 0 NOT NULL,
  `total_resets` integer DEFAULT 0 NOT NULL,
  `last_count_at` integer,
  PRIMARY KEY (`guild_id`, `channel_id`)
);
