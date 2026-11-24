-- Dreamliner Wrapped: the yearly recap on the website (/wrapped). Three small tables that only hold
-- aggregate counts or play history for the user themselves. Message text is never stored.

-- Emoji a user used in their messages (unicode and custom) and the reactions they added, counted per
-- user per calendar year (UTC). Custom emoji keep their id, name and animated flag so the site can
-- draw them from Discord's CDN; unicode emoji are keyed by the emoji itself.
CREATE TABLE IF NOT EXISTS `wrapped_emoji_usage` (
  `user_id` text NOT NULL,
  `year` integer NOT NULL,
  `emoji_key` text NOT NULL,
  `emoji_id` text,
  `name` text NOT NULL,
  `animated` integer DEFAULT 0 NOT NULL,
  `message_count` integer DEFAULT 0 NOT NULL,
  `reaction_count` integer DEFAULT 0 NOT NULL,
  PRIMARY KEY (`user_id`, `year`, `emoji_key`)
);

-- Every track a user requested through the Music plugin, logged once when it actually starts playing
-- (autoplay picks and radio stations are left out).
CREATE TABLE IF NOT EXISTS `music_play_log` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` text NOT NULL,
  `guild_id` text NOT NULL,
  `title` text NOT NULL,
  `author` text,
  `uri` text,
  `artwork_url` text,
  `source_name` text,
  `duration_ms` integer DEFAULT 0 NOT NULL,
  `played_at` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS `music_play_log_user_time` ON `music_play_log` (`user_id`, `played_at`);

-- Dreamliner commands a user ran, counted per user per year (command_usage_* are per server only).
CREATE TABLE IF NOT EXISTS `wrapped_command_usage` (
  `user_id` text NOT NULL,
  `year` integer NOT NULL,
  `command_name` text NOT NULL,
  `uses` integer DEFAULT 0 NOT NULL,
  PRIMARY KEY (`user_id`, `year`, `command_name`)
);

-- Year-bounded per-user reads for Wrapped on tables that only had guild-first indexes.
CREATE INDEX IF NOT EXISTS `quiz_attempts_user_time` ON `quiz_attempts` (`user_id`, `started_at`);
CREATE INDEX IF NOT EXISTS `giveaway_entries_user` ON `giveaway_entries` (`user_id`, `entered_at`);
CREATE INDEX IF NOT EXISTS `giveaway_winners_user` ON `giveaway_winners` (`user_id`, `selected_at`);
CREATE INDEX IF NOT EXISTS `quiz_live_players_user` ON `quiz_live_players` (`user_id`, `joined_at`);
CREATE INDEX IF NOT EXISTS `plane_card_flights_user_started` ON `plane_card_flights` (`user_id`, `started_at`);
CREATE INDEX IF NOT EXISTS `invite_joins_inviter_joined` ON `invite_joins` (`inviter_id`, `joined_at`);
CREATE INDEX IF NOT EXISTS `dream_command_runs_user` ON `dream_command_runs` (`user_id`, `started_at`);
CREATE INDEX IF NOT EXISTS `starboard_posts_author_time` ON `starboard_posts` (`author_id`, `created_at`);
CREATE INDEX IF NOT EXISTS `activity_rewards_awarded_user` ON `activity_rewards_awarded` (`user_id`, `awarded_at`);
