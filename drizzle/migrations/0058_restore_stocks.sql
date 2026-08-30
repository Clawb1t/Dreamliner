-- Dreamliner Exchange (server stocks) restored.
CREATE TABLE IF NOT EXISTS `economy_stocks` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`guild_name` text NOT NULL,
	`guild_icon` text,
	`price` real DEFAULT 10 NOT NULL,
	`activity_score` real DEFAULT 1 NOT NULL,
	`listed_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `economy_stock_price_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`price` real NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `economy_stock_history_guild_time` ON `economy_stock_price_history` (`guild_id`,`recorded_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `economy_stock_activity_minutes` (
	`guild_id` text NOT NULL,
	`minute_bucket` text NOT NULL,
	`messages` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`guild_id`, `minute_bucket`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `economy_stock_holdings` (
	`user_id` text NOT NULL,
	`guild_id` text NOT NULL,
	`shares` real DEFAULT 0 NOT NULL,
	`cost_basis` real DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `guild_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `economy_stock_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`guild_id` text NOT NULL,
	`type` text NOT NULL,
	`shares` real NOT NULL,
	`price` real NOT NULL,
	`amount` real NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `economy_stock_tx_user_time` ON `economy_stock_transactions` (`user_id`,`created_at`);
