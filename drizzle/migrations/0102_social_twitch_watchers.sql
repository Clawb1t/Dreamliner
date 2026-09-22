CREATE TABLE `social_twitch_watchers` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `discord_channel_id` text NOT NULL,
  `source_user_id` text NOT NULL,
  `source_user_login` text NOT NULL,
  `source_user_display_name` text NOT NULL,
  `source_user_avatar_url` text,
  `source_user_url` text NOT NULL,
  `message_content` text DEFAULT '' NOT NULL,
  `mention_role_ids` text DEFAULT '[]' NOT NULL,
  `embed_config` text NOT NULL,
  `last_stream_id` text,
  `last_live_at` integer,
  `last_checked_at` integer,
  `enabled` integer DEFAULT 1 NOT NULL,
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `social_twitch_watchers_guild` ON `social_twitch_watchers` (`guild_id`);
