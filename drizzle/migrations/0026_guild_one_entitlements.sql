CREATE TABLE `guild_one_entitlements` (
	`entitlement_id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`sku_id` text NOT NULL,
	`user_id` text,
	`starts_at` integer,
	`ends_at` integer,
	`deleted` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE INDEX `guild_one_entitlements_guild_id` ON `guild_one_entitlements` (`guild_id`);
