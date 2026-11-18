CREATE TABLE IF NOT EXISTS `frontpage_takeovers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`priority` integer DEFAULT 0 NOT NULL,
	`config` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS `frontpage_takeovers_enabled_idx` ON `frontpage_takeovers` (`enabled`, `priority`);
