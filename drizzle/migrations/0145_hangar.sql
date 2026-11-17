-- The Hangar: plane cards overhaul. Numbered copies replace quantity stacks, plus pack tiers,
-- Parts, sets, flights, trades, the market and per-user Hangar state. Nothing in the card system
-- creates coins (see src/plugins/economy/hangar/ledger.ts). Bot code: src/plugins/economy/hangar/.

ALTER TABLE `plane_card_types` ADD `print_run` integer;
--> statement-breakpoint
ALTER TABLE `plane_card_types` ADD `retired_at` integer;
--> statement-breakpoint
CREATE TABLE `plane_card_copies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_type_id` integer NOT NULL,
	`owner_id` text NOT NULL,
	`serial` integer NOT NULL,
	`livery` text DEFAULT 'standard' NOT NULL,
	`first_edition` integer DEFAULT 0 NOT NULL,
	`level` integer DEFAULT 1 NOT NULL,
	`xp` integer DEFAULT 0 NOT NULL,
	`flights` integer DEFAULT 0 NOT NULL,
	`obtained_via` text NOT NULL,
	`locked_reason` text,
	`locked_ref` integer,
	`last_flight_at` integer,
	`minted_at` integer NOT NULL,
	`acquired_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plane_card_copies_type_serial` ON `plane_card_copies` (`card_type_id`,`serial`);
--> statement-breakpoint
CREATE INDEX `plane_card_copies_owner` ON `plane_card_copies` (`owner_id`,`card_type_id`);
--> statement-breakpoint
CREATE TABLE `plane_card_mint_counters` (
	`card_type_id` integer PRIMARY KEY NOT NULL,
	`next_serial` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plane_card_copy_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`copy_id` integer NOT NULL,
	`kind` text NOT NULL,
	`from_user_id` text,
	`to_user_id` text,
	`detail` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plane_card_copy_events_copy` ON `plane_card_copy_events` (`copy_id`,`id`);
--> statement-breakpoint
CREATE TABLE `plane_card_sets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`bonus_parts` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plane_card_sets_key_unique` ON `plane_card_sets` (`key`);
--> statement-breakpoint
CREATE TABLE `plane_card_set_members` (
	`set_id` integer NOT NULL,
	`card_type_id` integer NOT NULL,
	PRIMARY KEY(`set_id`, `card_type_id`)
);
--> statement-breakpoint
CREATE INDEX `plane_card_set_members_card` ON `plane_card_set_members` (`card_type_id`);
--> statement-breakpoint
CREATE TABLE `plane_card_set_completions` (
	`user_id` text NOT NULL,
	`set_id` integer NOT NULL,
	`completed_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `set_id`)
);
--> statement-breakpoint
CREATE TABLE `plane_card_packs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`price` real NOT NULL,
	`size` integer NOT NULL,
	`rarity_odds` text NOT NULL,
	`livery_odds` text NOT NULL,
	`guarantee_rarity` text,
	`pity_rarity` text,
	`pity_after` integer,
	`featured_set_id` integer,
	`starts_at` integer,
	`ends_at` integer,
	`enabled` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plane_card_packs_key_unique` ON `plane_card_packs` (`key`);
--> statement-breakpoint
ALTER TABLE `plane_card_pack_openings` ADD `source` text DEFAULT 'pack' NOT NULL;
--> statement-breakpoint
ALTER TABLE `plane_card_pack_openings` ADD `pack_key` text;
--> statement-breakpoint
ALTER TABLE `plane_card_pack_openings` ADD `pulls` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
CREATE INDEX `plane_card_pack_openings_time` ON `plane_card_pack_openings` (`created_at`);
--> statement-breakpoint
CREATE TABLE `plane_parts_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`delta` integer NOT NULL,
	`kind` text NOT NULL,
	`copy_id` integer,
	`ref` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plane_parts_ledger_user` ON `plane_parts_ledger` (`user_id`,`id`);
--> statement-breakpoint
CREATE INDEX `plane_parts_ledger_kind` ON `plane_parts_ledger` (`kind`);
--> statement-breakpoint
CREATE TABLE `plane_coin_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`delta` real NOT NULL,
	`kind` text NOT NULL,
	`counterparty_id` text,
	`ref` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plane_coin_ledger_user` ON `plane_coin_ledger` (`user_id`,`id`);
--> statement-breakpoint
CREATE INDEX `plane_coin_ledger_kind` ON `plane_coin_ledger` (`kind`);
--> statement-breakpoint
CREATE TABLE `plane_card_flights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`copy_id` integer NOT NULL,
	`operator_copy_id` integer,
	`route` text NOT NULL,
	`started_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`claimed_at` integer,
	`reward` text
);
--> statement-breakpoint
CREATE INDEX `plane_card_flights_user` ON `plane_card_flights` (`user_id`,`claimed_at`);
--> statement-breakpoint
CREATE INDEX `plane_card_flights_claimed` ON `plane_card_flights` (`claimed_at`);
--> statement-breakpoint
CREATE TABLE `plane_card_trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_user_id` text NOT NULL,
	`to_user_id` text NOT NULL,
	`from_coins` real DEFAULT 0 NOT NULL,
	`to_coins` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`parent_trade_id` integer,
	`note` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `plane_card_trades_from` ON `plane_card_trades` (`from_user_id`,`status`);
--> statement-breakpoint
CREATE INDEX `plane_card_trades_to` ON `plane_card_trades` (`to_user_id`,`status`);
--> statement-breakpoint
CREATE INDEX `plane_card_trades_status` ON `plane_card_trades` (`status`,`expires_at`);
--> statement-breakpoint
CREATE TABLE `plane_card_trade_items` (
	`trade_id` integer NOT NULL,
	`copy_id` integer NOT NULL,
	`side` text NOT NULL,
	PRIMARY KEY(`trade_id`, `copy_id`)
);
--> statement-breakpoint
CREATE TABLE `plane_card_listings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`seller_id` text NOT NULL,
	`copy_id` integer NOT NULL,
	`price` real NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`buyer_id` text,
	`fee` real,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `plane_card_listings_status` ON `plane_card_listings` (`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `plane_card_listings_seller` ON `plane_card_listings` (`seller_id`,`status`);
--> statement-breakpoint
CREATE INDEX `plane_card_listings_copy` ON `plane_card_listings` (`copy_id`,`status`);
--> statement-breakpoint
CREATE TABLE `plane_card_user_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`boarding_last_at` integer,
	`boarding_streak` integer DEFAULT 0 NOT NULL,
	`pity` text DEFAULT '{}' NOT NULL,
	`showcase` text DEFAULT '[]' NOT NULL,
	`hangar_slots` integer DEFAULT 100 NOT NULL,
	`fleet_value` integer DEFAULT 0 NOT NULL,
	`sets_completed` integer DEFAULT 0 NOT NULL,
	`distinct_cards` integer DEFAULT 0 NOT NULL,
	`copies_count` integer DEFAULT 0 NOT NULL,
	`mythics_owned` integer DEFAULT 0 NOT NULL,
	`rarest_points` integer DEFAULT 0 NOT NULL,
	`rarest_copy_id` integer,
	`score_version` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plane_card_user_state_fleet` ON `plane_card_user_state` (`fleet_value`);
--> statement-breakpoint
CREATE INDEX `plane_card_user_state_sets` ON `plane_card_user_state` (`sets_completed`);
--> statement-breakpoint
CREATE INDEX `plane_card_user_state_rarest` ON `plane_card_user_state` (`rarest_points`);
--> statement-breakpoint
-- Stacks to copies: each inventory row becomes `quantity` numbered copies (Standard livery,
-- obtained via migration). Serials are handed out per card type in order of first acquisition,
-- so every existing copy lands in the first 100 and is First Edition.
INSERT INTO `plane_card_copies` (`card_type_id`, `owner_id`, `serial`, `livery`, `first_edition`, `level`, `xp`, `flights`, `obtained_via`, `minted_at`, `acquired_at`)
SELECT `card_type_id`, `owner_id`, `serial`, 'standard', CASE WHEN `serial` <= 100 THEN 1 ELSE 0 END, 1, 0, 0, 'migration', `obtained_at`, `obtained_at`
FROM (
	WITH RECURSIVE `n`(`i`) AS (
		SELECT 1
		UNION ALL
		SELECT `i` + 1 FROM `n` WHERE `i` < (SELECT COALESCE(MAX(`quantity`), 0) FROM `plane_card_inventory`)
	)
	SELECT
		inv.`plane_type_id` AS `card_type_id`,
		inv.`user_id` AS `owner_id`,
		inv.`first_obtained_at` AS `obtained_at`,
		ROW_NUMBER() OVER (PARTITION BY inv.`plane_type_id` ORDER BY inv.`first_obtained_at`, inv.`user_id`, `n`.`i`) AS `serial`
	FROM `plane_card_inventory` inv
	JOIN `n` ON `n`.`i` <= inv.`quantity`
	JOIN `plane_card_types` t ON t.`id` = inv.`plane_type_id`
	WHERE inv.`quantity` > 0
);
--> statement-breakpoint
INSERT INTO `plane_card_copy_events` (`copy_id`, `kind`, `from_user_id`, `to_user_id`, `detail`, `created_at`)
SELECT `id`, 'mint', NULL, `owner_id`, '{"via":"migration","livery":"standard"}', `minted_at` FROM `plane_card_copies`;
--> statement-breakpoint
INSERT INTO `plane_card_mint_counters` (`card_type_id`, `next_serial`)
SELECT t.`id`, 1 + (SELECT COUNT(*) FROM `plane_card_copies` c WHERE c.`card_type_id` = t.`id`) FROM `plane_card_types` t;
--> statement-breakpoint
-- Score columns start stale (score_version 0); the bot recomputes them on boot.
INSERT INTO `plane_card_user_state` (`user_id`, `copies_count`, `updated_at`)
SELECT `owner_id`, COUNT(*), CAST(strftime('%s', 'now') AS INTEGER) FROM `plane_card_copies` GROUP BY `owner_id`;
--> statement-breakpoint
DROP TABLE `plane_card_inventory`;
--> statement-breakpoint
-- Pack price/size moved to plane_card_packs.
DROP TABLE `plane_global_settings`;
--> statement-breakpoint
-- Pack tiers. Odds are weights; see src/plugins/economy/hangar/constants.ts DEFAULT_PACKS.
INSERT INTO `plane_card_packs` (`key`, `name`, `description`, `price`, `size`, `rarity_odds`, `livery_odds`, `guarantee_rarity`, `pity_rarity`, `pity_after`, `enabled`, `sort_order`, `created_at`, `updated_at`) VALUES
	('economy', 'Economy', '3 cards. The everyday pack.', 25, 3, '{"common":60,"uncommon":25,"rare":10,"epic":4,"legendary":0.9,"mythic":0.1}', '{"standard":88,"gold":10,"prototype":2}', NULL, NULL, NULL, 1, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
	('business', 'Business', '5 cards with at least one Uncommon or better.', 90, 5, '{"common":42,"uncommon":32,"rare":17,"epic":7,"legendary":1.8,"mythic":0.2}', '{"standard":88,"gold":10,"prototype":2}', 'uncommon', NULL, NULL, 1, 2, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
	('first_class', 'First Class', '5 cards with at least one Rare or better, raised Legendary odds and a Legendary within 40 cards.', 300, 5, '{"common":15,"uncommon":30,"rare":32,"epic":16,"legendary":6.3,"mythic":0.7}', '{"standard":84,"gold":13,"prototype":3}', 'rare', 'legendary', 40, 1, 3, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER));
--> statement-breakpoint
-- New cards from the art already in assets/planes/: the first Common and Uncommon cards, a
-- Boeing 747, a Global 8000, and two Mythic launch airframes with print runs.
INSERT OR IGNORE INTO `plane_card_types` (`key`, `name`, `card_type`, `subtitle`, `rarity`, `speed`, `agility`, `passenger_count`, `reputation`, `fleet_size`, `destinations`, `safety`, `image_key`, `enabled`, `print_run`, `created_by`, `created_at`, `updated_at`) VALUES
	('cessna-152', 'Cessna 152', 'plane', 'Cessna', 'common', 20, 72, 1, 50, 0, 0, 82, 'cessna-152.png', 1, NULL, 'system', CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
	('cessna-172', 'Cessna 172 Skyhawk', 'plane', 'Cessna', 'common', 22, 68, 3, 50, 0, 0, 86, 'cessna-172.png', 1, NULL, 'system', CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
	('piper-pa-28', 'Piper PA-28 Cherokee', 'plane', 'Piper', 'common', 23, 64, 3, 50, 0, 0, 80, 'piper-pa-28.png', 1, NULL, 'system', CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
	('diamond-da20', 'Diamond DA20', 'plane', 'Diamond Aircraft', 'common', 24, 76, 1, 50, 0, 0, 84, 'da20.png', 1, NULL, 'system', CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
	('diamond-da40', 'Diamond DA40', 'plane', 'Diamond Aircraft', 'uncommon', 28, 72, 3, 50, 0, 0, 90, 'da40.png', 1, NULL, 'system', CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
	('gulfstream-g800', 'Gulfstream G800', 'plane', 'Gulfstream', 'uncommon', 90, 70, 19, 50, 0, 0, 92, 'g800.png', 1, NULL, 'system', CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
	('spirit-airlines', 'Spirit Airlines', 'airline', 'Ultra low cost, United States', 'uncommon', 50, 50, 0, 38, 200, 90, 82, 'al_spirit.png', 1, NULL, 'system', CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
	('bombardier-global-8000', 'Bombardier Global 8000', 'plane', 'Bombardier', 'rare', 95, 72, 19, 50, 0, 0, 93, 'g8000.png', 1, NULL, 'system', CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
	('boeing-747', 'Boeing 747', 'plane', 'Boeing', 'epic', 84, 34, 416, 50, 0, 0, 86, '747.png', 1, NULL, 'system', CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
	('boeing-747-usa-edition', 'Boeing 747 USA Edition', 'plane', 'Boeing, launch airframe', 'mythic', 86, 36, 102, 50, 0, 0, 99, '747-usa.png', 1, 100, 'system', CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
	('boeing-747-vintage-usa-edition', 'Boeing 747 Vintage USA Edition', 'plane', 'Boeing, launch airframe', 'mythic', 84, 34, 102, 50, 0, 0, 98, '747-vintage-usa.png', 1, 50, 'system', CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER));
--> statement-breakpoint
INSERT OR IGNORE INTO `plane_card_mint_counters` (`card_type_id`, `next_serial`) SELECT `id`, 1 FROM `plane_card_types`;
--> statement-breakpoint
-- Starter sets ("Fleets").
INSERT INTO `plane_card_sets` (`key`, `name`, `description`, `bonus_parts`, `enabled`, `created_at`, `updated_at`) VALUES
	('airbus-family', 'Airbus Family', 'Every Airbus jetliner in the Hangar.', 300, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
	('boeing-jetliners', 'Boeing Jetliners', 'From the 717 to the Dreamliner.', 300, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
	('flight-school', 'Flight School', 'The trainers everyone learns on.', 60, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)),
	('airlines', 'Airlines', 'Every airline operator card.', 200, 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER));
--> statement-breakpoint
INSERT OR IGNORE INTO `plane_card_set_members` (`set_id`, `card_type_id`)
SELECT s.`id`, t.`id` FROM `plane_card_sets` s JOIN `plane_card_types` t ON (
	(s.`key` = 'airbus-family' AND t.`key` IN ('airbus-a220', 'airbus-a320', 'airbus-a321-neo', 'airbus-a330', 'airbus-a340', 'airbus-a350', 'airbus-a380'))
	OR (s.`key` = 'boeing-jetliners' AND t.`key` IN ('boeing-717', 'boeing-737', 'boeing-747', 'boeing-767', 'boeing-777', 'boeing-787-dreamliner'))
	OR (s.`key` = 'flight-school' AND t.`key` IN ('cessna-152', 'cessna-172', 'piper-pa-28', 'diamond-da20', 'diamond-da40'))
	OR (s.`key` = 'airlines' AND t.`key` IN ('british-airways', 'ryanair', 'tui', 'delta-air-lines', 'spirit-airlines'))
);
--> statement-breakpoint
-- Existing Dreamliner Roles that could already use /planes get the new Hangar flags.
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT g.`role_id`, k.`grant_key` FROM `guild_permission_role_grants` g
JOIN (
	SELECT 'economy.can_boarding' AS `grant_key` UNION ALL SELECT 'economy.can_salvage' UNION ALL SELECT 'economy.can_craft'
	UNION ALL SELECT 'economy.can_repaint' UNION ALL SELECT 'economy.can_upgrade' UNION ALL SELECT 'economy.can_fly'
	UNION ALL SELECT 'economy.can_trade' UNION ALL SELECT 'economy.can_market'
) k
WHERE g.`grant_key` = 'economy.can_view';
