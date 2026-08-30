CREATE TABLE IF NOT EXISTS `anime_saved_nekos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`image_url` text NOT NULL,
	`artist_name` text,
	`artist_href` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `anime_saved_nekos_user_time` ON `anime_saved_nekos` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `anime_saved_nekos_user_image` ON `anime_saved_nekos` (`user_id`,`image_url`);
