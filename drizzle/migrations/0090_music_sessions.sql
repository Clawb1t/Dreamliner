CREATE TABLE IF NOT EXISTS `music_sessions` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`voice_channel_id` text NOT NULL,
	`text_channel_id` text NOT NULL,
	`current_track_encoded` text,
	`current_track_title` text,
	`current_track_author` text,
	`current_track_uri` text,
	`current_track_artwork_url` text,
	`current_track_duration_ms` integer,
	`current_track_source_name` text,
	`current_track_requested_by` text,
	`position_ms` integer DEFAULT 0 NOT NULL,
	`volume` integer DEFAULT 80 NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`loop_mode` text DEFAULT 'off' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `music_queue_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`position` integer NOT NULL,
	`encoded` text NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`uri` text,
	`artwork_url` text,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`source_name` text,
	`requested_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `music_queue_items_guild` ON `music_queue_items` (`guild_id`,`position`);
