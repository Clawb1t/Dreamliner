CREATE TABLE IF NOT EXISTS `music_playlists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `music_playlists_owner_name` ON `music_playlists` (`owner_id`,`name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `music_playlists_owner` ON `music_playlists` (`owner_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `music_playlist_tracks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`playlist_id` integer NOT NULL,
	`position` integer NOT NULL,
	`encoded` text,
	`title` text NOT NULL,
	`artist` text,
	`uri` text,
	`artwork_url` text,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `music_playlist_tracks_playlist` ON `music_playlist_tracks` (`playlist_id`,`position`);
