CREATE TABLE `one_discount_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`label` text,
	`days` integer,
	`max_redemptions` integer,
	`redemption_count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
CREATE TABLE `one_discount_redemptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`redeemed_at` integer NOT NULL
);
CREATE UNIQUE INDEX `one_discount_redemptions_code_guild` ON `one_discount_redemptions` (`code`, `guild_id`);
