CREATE TABLE `guild_ai_usage` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`free_uses_consumed` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer
);
