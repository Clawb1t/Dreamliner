CREATE TABLE `starboard_posts` (
	`guild_id` text NOT NULL,
	`board_name` text NOT NULL,
	`source_message_id` text NOT NULL,
	`source_channel_id` text NOT NULL,
	`starboard_message_id` text NOT NULL,
	`star_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `board_name`, `source_message_id`)
);
