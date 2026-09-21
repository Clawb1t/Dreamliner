ALTER TABLE `giveaways` ADD COLUMN `entry_cost` real DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `giveaways` ADD COLUMN `win_bonus` real DEFAULT 0 NOT NULL;
