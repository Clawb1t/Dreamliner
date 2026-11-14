-- Social Notifications upgrade: per-creator options (upload types, stream end, cooldown, quiet hours,
-- subscriber milestones), an all-time delivered counter on each watcher, a "last seen live" time for
-- Twitch stream-end detection, and a deliveries log for dashboard stats, recent notifications and
-- editing a live message once the stream ends. Existing watchers keep their old behaviour ('{}' parses
-- to defaults).
ALTER TABLE `social_youtube_watchers` ADD COLUMN `options` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `social_youtube_watchers` ADD COLUMN `delivered_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `social_twitch_watchers` ADD COLUMN `options` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `social_twitch_watchers` ADD COLUMN `delivered_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `social_twitch_watchers` ADD COLUMN `last_seen_live_at` integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `social_deliveries` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `platform` text NOT NULL,
  `watcher_id` integer NOT NULL,
  `guild_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `message_id` text,
  `kind` text NOT NULL,
  `item_id` text NOT NULL,
  `title` text DEFAULT '' NOT NULL,
  `url` text DEFAULT '' NOT NULL,
  `thumbnail_url` text,
  `game_name` text,
  `peak_viewers` integer DEFAULT 0 NOT NULL,
  `started_at` integer,
  `ended_at` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `social_deliveries_guild_created` ON `social_deliveries` (`guild_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `social_deliveries_watcher` ON `social_deliveries` (`platform`, `watcher_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `social_deliveries_created` ON `social_deliveries` (`created_at`);
