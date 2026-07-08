CREATE TABLE `log_messages` (
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`author_id` text NOT NULL,
	`author_name` text NOT NULL,
	`channel_name` text,
	`content` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `channel_id`, `message_id`)
);

CREATE INDEX `log_messages_updated_at_idx` ON `log_messages` (`updated_at`);
