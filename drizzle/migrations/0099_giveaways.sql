CREATE TABLE IF NOT EXISTS `giveaways` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text,
	`title` text NOT NULL,
	`prize` text NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`entry_method` text DEFAULT 'button' NOT NULL,
	`reaction_emoji` text DEFAULT '🎉' NOT NULL,
	`button_label` text DEFAULT 'Enter' NOT NULL,
	`button_emoji` text DEFAULT '' NOT NULL,
	`button_style` text DEFAULT 'primary' NOT NULL,
	`embed_config` text DEFAULT '{}' NOT NULL,
	`winner_count` integer DEFAULT 1 NOT NULL,
	`require_role_ids` text DEFAULT '[]' NOT NULL,
	`require_role_mode` text DEFAULT 'any' NOT NULL,
	`blacklist_role_ids` text DEFAULT '[]' NOT NULL,
	`bypass_role_ids` text DEFAULT '[]' NOT NULL,
	`min_account_age_days` integer DEFAULT 0 NOT NULL,
	`min_join_age_days` integer DEFAULT 0 NOT NULL,
	`bonus_role_weights` text DEFAULT '[]' NOT NULL,
	`booster_bonus_weight` real DEFAULT 0 NOT NULL,
	`ping_role_id` text,
	`dm_winner` integer DEFAULT true NOT NULL,
	`dm_non_winners` integer DEFAULT false NOT NULL,
	`claim_window_minutes` integer DEFAULT 0 NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`paused_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `giveaways_guild` ON `giveaways` (`guild_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `giveaways_status_end` ON `giveaways` (`status`,`ends_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `giveaway_entries` (
	`giveaway_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`entered_at` integer NOT NULL,
	PRIMARY KEY(`giveaway_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `giveaway_entries_giveaway` ON `giveaway_entries` (`giveaway_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `giveaway_winners` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`giveaway_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'won' NOT NULL,
	`selected_at` integer NOT NULL,
	`claimed_at` integer,
	`rerolled_at` integer,
	`replaces_winner_id` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `giveaway_winners_giveaway` ON `giveaway_winners` (`giveaway_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `giveaway_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`name` text NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `giveaway_templates_guild` ON `giveaway_templates` (`guild_id`);
