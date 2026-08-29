DROP TABLE IF EXISTS `economy_currencies`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_accounts`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_transactions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_profiles`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_cooldowns`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_streaks`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_items`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_shops`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_shop_listings`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_inventory`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_effects`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_jobs`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_pet_species`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_pets`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_recipes`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_craft_queue`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_quests`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_quest_progress`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_achievements`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_achievement_progress`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_trades`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_trade_offers`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_market_listings`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_auctions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_auction_bids`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_auction_watches`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_seasons`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_season_scores`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_daily_stats`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_scheduler_leases`;
--> statement-breakpoint
DROP TABLE IF EXISTS `economy_guild_state`;
--> statement-breakpoint
CREATE TABLE `economy_global_accounts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`balance` real DEFAULT 0 NOT NULL,
	`last_message_at` integer,
	`last_daily_at` integer,
	`daily_streak` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `economy_server_accounts` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`balance` real DEFAULT 0 NOT NULL,
	`last_message_at` integer,
	`last_daily_at` integer,
	`daily_streak` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`)
);
