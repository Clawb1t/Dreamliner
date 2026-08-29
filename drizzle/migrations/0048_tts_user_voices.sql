CREATE TABLE `tts_user_voices` (
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `voice` text NOT NULL,
  PRIMARY KEY (`guild_id`, `user_id`)
);
