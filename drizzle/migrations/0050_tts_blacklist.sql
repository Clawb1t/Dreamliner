CREATE TABLE `tts_blacklist` (
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `reason` text,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`guild_id`, `user_id`)
);
