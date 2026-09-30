CREATE TABLE `user_progression_badge_hidden` (
  `user_id` text NOT NULL,
  `badge_key` text NOT NULL,
  `hidden_at` integer NOT NULL,
  PRIMARY KEY(`user_id`, `badge_key`)
);
