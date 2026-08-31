-- Plane trading cards.
CREATE TABLE IF NOT EXISTS `plane_card_types` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`manufacturer` text DEFAULT '' NOT NULL,
	`rarity` text DEFAULT 'common' NOT NULL,
	`speed` integer DEFAULT 50 NOT NULL,
	`agility` integer DEFAULT 50 NOT NULL,
	`safety` integer DEFAULT 50 NOT NULL,
	`passenger_count` integer DEFAULT 0 NOT NULL,
	`image_url` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `plane_card_types_key_unique` ON `plane_card_types` (`key`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `plane_card_inventory` (
	`user_id` text NOT NULL,
	`plane_type_id` integer NOT NULL,
	`quantity` integer DEFAULT 0 NOT NULL,
	`first_obtained_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `plane_type_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `plane_card_pack_openings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`guild_id` text NOT NULL,
	`cost` real NOT NULL,
	`plane_type_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `plane_card_pack_openings_user_time` ON `plane_card_pack_openings` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `plane_card_trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`proposer_id` text NOT NULL,
	`target_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`guild_id` text,
	`channel_id` text,
	`message_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `plane_card_trades_proposer` ON `plane_card_trades` (`proposer_id`,`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `plane_card_trades_target` ON `plane_card_trades` (`target_id`,`status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `plane_card_trade_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trade_id` integer NOT NULL,
	`side` text NOT NULL,
	`plane_type_id` integer NOT NULL,
	`quantity` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `plane_card_trade_items_trade` ON `plane_card_trade_items` (`trade_id`);
