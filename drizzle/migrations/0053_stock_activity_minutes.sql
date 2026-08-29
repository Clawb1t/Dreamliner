CREATE TABLE `economy_stock_activity_minutes` (
	`guild_id` text NOT NULL,
	`minute_bucket` text NOT NULL,
	`messages` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`guild_id`, `minute_bucket`)
);
