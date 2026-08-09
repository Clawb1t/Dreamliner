CREATE TABLE `reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`rating` integer NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`anonymous` integer DEFAULT false NOT NULL,
	`channel_id` text,
	`message_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);

CREATE TABLE `suggestions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`suggestion_number` integer NOT NULL,
	`author_id` text NOT NULL,
	`content` text NOT NULL,
	`attachment_url` text,
	`anonymous` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'awaiting_review' NOT NULL,
	`display_status` text DEFAULT 'none' NOT NULL,
	`review_channel_id` text,
	`review_message_id` text,
	`feed_channel_id` text,
	`feed_message_id` text,
	`denied_channel_id` text,
	`denied_message_id` text,
	`archive_channel_id` text,
	`archive_message_id` text,
	`staff_actor_id` text,
	`denial_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`implemented_at` integer
);

CREATE TABLE `suggestion_votes` (
	`suggestion_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`suggestion_id`, `user_id`)
);

CREATE TABLE `suggestion_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`suggestion_id` integer NOT NULL,
	`author_id` text NOT NULL,
	`content` text NOT NULL,
	`anonymous` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);

CREATE TABLE `suggestion_blocks` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`reason` text,
	`expires_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`)
);

CREATE TABLE `suggestion_follows` (
	`suggestion_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`suggestion_id`, `user_id`)
);
