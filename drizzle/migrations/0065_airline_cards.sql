-- Airline cards: a second card type alongside planes, sharing the same catalog/inventory/packs.
ALTER TABLE `plane_card_types` RENAME COLUMN `manufacturer` TO `subtitle`;
--> statement-breakpoint
ALTER TABLE `plane_card_types` ADD COLUMN `card_type` text DEFAULT 'plane' NOT NULL;
--> statement-breakpoint
ALTER TABLE `plane_card_types` ADD COLUMN `reputation` integer DEFAULT 50 NOT NULL;
--> statement-breakpoint
ALTER TABLE `plane_card_types` ADD COLUMN `fleet_size` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `plane_card_types` ADD COLUMN `destinations` integer DEFAULT 0 NOT NULL;
