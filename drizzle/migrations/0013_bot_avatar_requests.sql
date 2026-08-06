CREATE TABLE `bot_avatar_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`requester_id` text NOT NULL,
	`request_channel_id` text NOT NULL,
	`request_message_id` text,
	`review_message_id` text,
	`avatar_png` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewer_id` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
