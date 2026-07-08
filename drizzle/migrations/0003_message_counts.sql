CREATE TABLE `guild_message_counts` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `user_message_counts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL
);
