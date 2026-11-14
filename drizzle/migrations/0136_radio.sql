-- Dreamliner Radio: operator-run stations with uploaded MP3s, a persisted global clock per station,
-- chunked upload sessions, and which station a guild's music session is tuned to.
CREATE TABLE `radio_stations` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`genre` text,
	`accent_color` text,
	`icon_asset_id` text,
	`shuffle` integer DEFAULT 0 NOT NULL,
	`visibility` text DEFAULT 'draft' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `radio_stations_slug_unique` ON `radio_stations` (`slug`);
--> statement-breakpoint
CREATE TABLE `radio_tracks` (
	`id` text PRIMARY KEY NOT NULL,
	`station_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`artist` text,
	`duration_ms` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`artwork_asset_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `radio_tracks_station` ON `radio_tracks` (`station_id`,`position`);
--> statement-breakpoint
CREATE TABLE `radio_station_state` (
	`station_id` text PRIMARY KEY NOT NULL,
	`current_track_id` text,
	`offset_ms` integer DEFAULT 0 NOT NULL,
	`order_seed` integer DEFAULT 0 NOT NULL,
	`saved_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `radio_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`station_id` text NOT NULL,
	`filename` text NOT NULL,
	`expected_bytes` integer NOT NULL,
	`received_bytes` integer DEFAULT 0 NOT NULL,
	`next_index` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `music_sessions` ADD COLUMN `radio_station_id` text;
