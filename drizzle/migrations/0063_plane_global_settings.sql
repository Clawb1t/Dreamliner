-- Global (not per-guild) plane pack price/size, managed only via /planesadmin.
CREATE TABLE IF NOT EXISTS `plane_global_settings` (
	`id` text PRIMARY KEY DEFAULT 'global' NOT NULL,
	`pack_price` real DEFAULT 10 NOT NULL,
	`pack_size` integer DEFAULT 1 NOT NULL,
	`updated_by` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL
);
