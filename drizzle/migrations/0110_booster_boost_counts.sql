CREATE TABLE `booster_boost_counts` (
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `boosts` integer DEFAULT 0 NOT NULL,
  `last_message_id` text,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`guild_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `booster_boost_backfills` (
  `guild_id` text PRIMARY KEY NOT NULL,
  `channel_id` text NOT NULL,
  `scanned_messages` integer DEFAULT 0 NOT NULL,
  `boost_messages` integer DEFAULT 0 NOT NULL,
  `oldest_message_at` integer,
  `finished_at` integer NOT NULL
);
