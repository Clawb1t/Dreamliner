-- Dreamliner Store: an admin-managed product catalog, product-aware ledger rows with idempotent
-- purchases (request_id), and entitlements recording what each member bought.
CREATE TABLE `store_products` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`tagline` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`price_credits` integer NOT NULL,
	`image_asset_id` text,
	`hero_asset_id` text,
	`accent_color` integer,
	`badge` text,
	`section` text DEFAULT '' NOT NULL,
	`featured` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`config_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
INSERT OR IGNORE INTO `store_products` (
	`id`, `type`, `name`, `tagline`, `description`, `price_credits`, `image_asset_id`, `hero_asset_id`,
	`accent_color`, `badge`, `section`, `featured`, `sort_order`, `active`, `starts_at`, `ends_at`,
	`config_json`, `created_at`, `updated_at`, `updated_by`
) VALUES (
	'dreamliner-one',
	'one_days',
	'Dreamliner One',
	'Unlock every premium feature for a server',
	'Dreamliner One unlocks the premium side of Dreamliner for a server you manage. Days stack on top of any time the server already has.

- **Custom bot branding**: your own avatar, banner, nickname and bio for Dreamliner in your server
- **Auto translate**: messages in other languages get a translation posted underneath
- **Higher limits**: 50 tracked creators in Social Notifications instead of 10
- **Unlimited Autopilot**: set up any plugin in plain language, as often as you like',
	20,
	NULL,
	NULL,
	5793266,
	NULL,
	'Dreamliner One',
	1,
	0,
	1,
	NULL,
	NULL,
	'{"dayStep":2,"maxDays":90}',
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	NULL
);
--> statement-breakpoint
ALTER TABLE `store_credit_ledger` ADD `product_id` text;
--> statement-breakpoint
ALTER TABLE `store_credit_ledger` ADD `request_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `store_credit_ledger_request` ON `store_credit_ledger` (`user_id`, `request_id`);
--> statement-breakpoint
UPDATE `store_credit_ledger` SET `product_id` = 'dreamliner-one' WHERE `kind` = 'purchase' AND `product_id` IS NULL;
--> statement-breakpoint
CREATE TABLE `store_entitlements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`product_id` text NOT NULL,
	`guild_id` text,
	`quantity` integer DEFAULT 1 NOT NULL,
	`days` integer,
	`expires_at` integer,
	`ledger_id` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `store_entitlements_user` ON `store_entitlements` (`user_id`, `product_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `store_entitlements_ledger` ON `store_entitlements` (`ledger_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `store_entitlements` (`user_id`, `product_id`, `guild_id`, `quantity`, `days`, `expires_at`, `ledger_id`, `created_at`)
SELECT `user_id`, 'dreamliner-one', `guild_id`, 1, `days`, NULL, `id`, `created_at`
FROM `store_credit_ledger` WHERE `kind` = 'purchase';
