CREATE TABLE IF NOT EXISTS `guild_log_events` (
  `id` text PRIMARY KEY NOT NULL,
  `guild_id` text NOT NULL,
  `created_at` integer NOT NULL,
  `category` text NOT NULL,
  `event_type` text NOT NULL,
  `title` text NOT NULL,
  `summary` text NOT NULL DEFAULT '',
  `actor_id` text,
  `target_id` text,
  `channel_id` text,
  `message_id` text,
  `case_id` integer,
  `payload` text NOT NULL DEFAULT '{}',
  `discord_message_id` text
);

CREATE INDEX IF NOT EXISTS `guild_log_events_guild_created_idx`
  ON `guild_log_events` (`guild_id`, `created_at`);

CREATE INDEX IF NOT EXISTS `guild_log_events_guild_type_idx`
  ON `guild_log_events` (`guild_id`, `event_type`);

CREATE INDEX IF NOT EXISTS `guild_log_events_guild_case_idx`
  ON `guild_log_events` (`guild_id`, `case_id`);
