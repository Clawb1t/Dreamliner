CREATE TABLE `economy_currencies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`name_singular` text NOT NULL,
	`symbol` text DEFAULT '🪙' NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`tradeable` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `economy_currencies_guild_key` ON `economy_currencies` (`guild_id`,`key`);
--> statement-breakpoint
CREATE TABLE `economy_accounts` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`currency_key` text NOT NULL,
	`pocket` integer DEFAULT 0 NOT NULL,
	`bank` integer DEFAULT 0 NOT NULL,
	`frozen` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`, `currency_key`)
);
--> statement-breakpoint
CREATE TABLE `economy_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`currency_key` text NOT NULL,
	`delta_pocket` integer DEFAULT 0 NOT NULL,
	`delta_bank` integer DEFAULT 0 NOT NULL,
	`delta_frozen` integer DEFAULT 0 NOT NULL,
	`balance_pocket` integer NOT NULL,
	`balance_bank` integer NOT NULL,
	`balance_frozen` integer NOT NULL,
	`reason` text NOT NULL,
	`actor_id` text,
	`ref_type` text,
	`ref_id` text,
	`idempotency_key` text,
	`meta_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `economy_tx_guild_user_idx` ON `economy_transactions` (`guild_id`,`user_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `economy_tx_idempotency_idx` ON `economy_transactions` (`guild_id`,`idempotency_key`) WHERE `idempotency_key` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `economy_profiles` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`xp` integer DEFAULT 0 NOT NULL,
	`level` integer DEFAULT 1 NOT NULL,
	`prestige` integer DEFAULT 0 NOT NULL,
	`hide_balances` integer DEFAULT false NOT NULL,
	`frozen` integer DEFAULT false NOT NULL,
	`freeze_reason` text,
	`job_key` text,
	`job_xp` integer DEFAULT 0 NOT NULL,
	`job_level` integer DEFAULT 1 NOT NULL,
	`active_pet_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `economy_cooldowns` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`available_at` integer NOT NULL,
	`meta_json` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `economy_streaks` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`last_claim_at` integer,
	`last_claim_day` text,
	PRIMARY KEY(`guild_id`, `user_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `economy_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`emoji` text DEFAULT '📦' NOT NULL,
	`item_type` text DEFAULT 'collectible' NOT NULL,
	`stackable` integer DEFAULT true NOT NULL,
	`tradeable` integer DEFAULT true NOT NULL,
	`sell_value` integer DEFAULT 0 NOT NULL,
	`currency_key` text DEFAULT 'coins' NOT NULL,
	`effect_json` text DEFAULT '{}' NOT NULL,
	`loot_json` text DEFAULT '[]' NOT NULL,
	`role_id` text,
	`pet_species_key` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `economy_items_guild_key` ON `economy_items` (`guild_id`,`key`);
--> statement-breakpoint
CREATE TABLE `economy_shops` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`channel_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `economy_shops_guild_key` ON `economy_shops` (`guild_id`,`key`);
--> statement-breakpoint
CREATE TABLE `economy_shop_listings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`shop_id` integer NOT NULL,
	`item_id` integer NOT NULL,
	`price` integer NOT NULL,
	`currency_key` text DEFAULT 'coins' NOT NULL,
	`stock` integer,
	`max_per_user` integer,
	`restock_amount` integer,
	`restock_interval_seconds` integer,
	`next_restock_at` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `economy_inventory` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`item_id` integer NOT NULL,
	`quantity` integer DEFAULT 0 NOT NULL,
	`equipped` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`, `item_id`)
);
--> statement-breakpoint
CREATE TABLE `economy_effects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`magnitude` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`meta_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `economy_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`emoji` text DEFAULT '💼' NOT NULL,
	`pay_min` integer DEFAULT 50 NOT NULL,
	`pay_max` integer DEFAULT 150 NOT NULL,
	`currency_key` text DEFAULT 'coins' NOT NULL,
	`cooldown_seconds` integer DEFAULT 3600 NOT NULL,
	`required_level` integer DEFAULT 1 NOT NULL,
	`required_item_id` integer,
	`fail_chance_bps` integer DEFAULT 0 NOT NULL,
	`fail_fine` integer DEFAULT 0 NOT NULL,
	`career_xp` integer DEFAULT 10 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`flavor_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `economy_jobs_guild_key` ON `economy_jobs` (`guild_id`,`key`);
--> statement-breakpoint
CREATE TABLE `economy_pet_species` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`emoji` text DEFAULT '🐾' NOT NULL,
	`rarity` text DEFAULT 'common' NOT NULL,
	`base_atk` integer DEFAULT 10 NOT NULL,
	`base_def` integer DEFAULT 10 NOT NULL,
	`base_hp` integer DEFAULT 50 NOT NULL,
	`base_speed` integer DEFAULT 10 NOT NULL,
	`adopt_cost` integer DEFAULT 500 NOT NULL,
	`currency_key` text DEFAULT 'coins' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `economy_pet_species_guild_key` ON `economy_pet_species` (`guild_id`,`key`);
--> statement-breakpoint
CREATE TABLE `economy_pets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`species_id` integer NOT NULL,
	`name` text NOT NULL,
	`xp` integer DEFAULT 0 NOT NULL,
	`level` integer DEFAULT 1 NOT NULL,
	`hunger` integer DEFAULT 100 NOT NULL,
	`energy` integer DEFAULT 100 NOT NULL,
	`happiness` integer DEFAULT 100 NOT NULL,
	`atk` integer DEFAULT 10 NOT NULL,
	`def` integer DEFAULT 10 NOT NULL,
	`hp` integer DEFAULT 50 NOT NULL,
	`speed` integer DEFAULT 10 NOT NULL,
	`last_tick_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `economy_pets_owner_idx` ON `economy_pets` (`guild_id`,`user_id`);
--> statement-breakpoint
CREATE TABLE `economy_recipes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`output_item_id` integer NOT NULL,
	`output_qty` integer DEFAULT 1 NOT NULL,
	`inputs_json` text DEFAULT '[]' NOT NULL,
	`duration_seconds` integer DEFAULT 60 NOT NULL,
	`required_level` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `economy_recipes_guild_key` ON `economy_recipes` (`guild_id`,`key`);
--> statement-breakpoint
CREATE TABLE `economy_craft_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`recipe_id` integer NOT NULL,
	`started_at` integer NOT NULL,
	`completes_at` integer NOT NULL,
	`collected` integer DEFAULT false NOT NULL,
	`cancelled` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `economy_craft_queue_user_idx` ON `economy_craft_queue` (`guild_id`,`user_id`);
--> statement-breakpoint
CREATE TABLE `economy_quests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`quest_type` text DEFAULT 'daily' NOT NULL,
	`objective_type` text NOT NULL,
	`objective_target` integer DEFAULT 1 NOT NULL,
	`reward_currency_key` text DEFAULT 'coins' NOT NULL,
	`reward_amount` integer DEFAULT 100 NOT NULL,
	`reward_item_id` integer,
	`reward_item_qty` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `economy_quests_guild_key` ON `economy_quests` (`guild_id`,`key`);
--> statement-breakpoint
CREATE TABLE `economy_quest_progress` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`quest_id` integer NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`claimed` integer DEFAULT false NOT NULL,
	`period_key` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`, `quest_id`, `period_key`)
);
--> statement-breakpoint
CREATE TABLE `economy_achievements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`objective_type` text NOT NULL,
	`objective_target` integer DEFAULT 1 NOT NULL,
	`reward_currency_key` text DEFAULT 'coins' NOT NULL,
	`reward_amount` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `economy_achievements_guild_key` ON `economy_achievements` (`guild_id`,`key`);
--> statement-breakpoint
CREATE TABLE `economy_achievement_progress` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`achievement_id` integer NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`completed_at` integer,
	PRIMARY KEY(`guild_id`, `user_id`, `achievement_id`)
);
--> statement-breakpoint
CREATE TABLE `economy_trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`initiator_id` text NOT NULL,
	`partner_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`initiator_confirmed` integer DEFAULT false NOT NULL,
	`partner_confirmed` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `economy_trades_guild_status_idx` ON `economy_trades` (`guild_id`,`status`);
--> statement-breakpoint
CREATE TABLE `economy_trade_offers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trade_id` integer NOT NULL,
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`offer_type` text NOT NULL,
	`currency_key` text,
	`amount` integer DEFAULT 0 NOT NULL,
	`item_id` integer,
	`quantity` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `economy_market_listings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`seller_id` text NOT NULL,
	`item_id` integer NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`price` integer NOT NULL,
	`currency_key` text DEFAULT 'coins' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`sold_at` integer,
	`buyer_id` text
);
--> statement-breakpoint
CREATE INDEX `economy_market_guild_status_idx` ON `economy_market_listings` (`guild_id`,`status`);
--> statement-breakpoint
CREATE TABLE `economy_auctions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`seller_id` text NOT NULL,
	`item_id` integer NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`currency_key` text DEFAULT 'coins' NOT NULL,
	`starting_bid` integer NOT NULL,
	`buyout_price` integer,
	`current_bid` integer DEFAULT 0 NOT NULL,
	`current_bidder_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`ends_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`settled_at` integer
);
--> statement-breakpoint
CREATE INDEX `economy_auctions_ends_idx` ON `economy_auctions` (`status`,`ends_at`);
--> statement-breakpoint
CREATE TABLE `economy_auction_bids` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`auction_id` integer NOT NULL,
	`guild_id` text NOT NULL,
	`bidder_id` text NOT NULL,
	`amount` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `economy_auction_watches` (
	`guild_id` text NOT NULL,
	`auction_id` integer NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`guild_id`, `auction_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `economy_seasons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`soft_reset` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`rewards_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `economy_seasons_guild_key` ON `economy_seasons` (`guild_id`,`key`);
--> statement-breakpoint
CREATE TABLE `economy_season_scores` (
	`guild_id` text NOT NULL,
	`season_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`claimed` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `season_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `economy_daily_stats` (
	`guild_id` text NOT NULL,
	`day` text NOT NULL,
	`minted` integer DEFAULT 0 NOT NULL,
	`sunk` integer DEFAULT 0 NOT NULL,
	`transfers` integer DEFAULT 0 NOT NULL,
	`shop_revenue` integer DEFAULT 0 NOT NULL,
	`market_volume` integer DEFAULT 0 NOT NULL,
	`admin_adjust` integer DEFAULT 0 NOT NULL,
	`active_users` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`guild_id`, `day`)
);
--> statement-breakpoint
CREATE TABLE `economy_scheduler_leases` (
	`guild_id` text NOT NULL,
	`task_key` text NOT NULL,
	`lease_until` integer NOT NULL,
	`last_run_at` integer,
	`checkpoint_json` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`guild_id`, `task_key`)
);
--> statement-breakpoint
CREATE TABLE `economy_guild_state` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`seeded` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
