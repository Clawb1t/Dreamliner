ALTER TABLE `user_profiles` ADD COLUMN `bio` text;
--> statement-breakpoint
ALTER TABLE `user_profiles` ADD COLUMN `profile_visible` integer DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE TABLE `badge_definitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`icon` text DEFAULT '' NOT NULL,
	`color_hex` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `badge_definitions_key_unique` ON `badge_definitions` (`key`);
--> statement-breakpoint
CREATE TABLE `user_badges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`badge_id` integer NOT NULL,
	`assigned_at` integer NOT NULL,
	`assigned_by` text NOT NULL,
	`displayed` integer DEFAULT true NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_badges_user_badge_idx` ON `user_badges` (`user_id`,`badge_id`);
