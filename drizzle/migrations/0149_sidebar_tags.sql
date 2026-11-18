CREATE TABLE IF NOT EXISTS `sidebar_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`color` text NOT NULL,
	`text_color` text,
	`icon` text,
	`style` text DEFAULT 'solid' NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS `sidebar_tags_enabled_idx` ON `sidebar_tags` (`enabled`, `target`);
-- Seed: the "New" badges that were hard-coded in the website's ConfigEditor (NEW_NAV_BADGES) and
-- still running when this shipped, with their end dates carried over (midnight UTC). Entries already
-- past their date showed nothing, so they aren't seeded. BETA_PLUGINS was empty.
INSERT INTO `sidebar_tags` (`target`, `kind`, `label`, `color`, `text_color`, `icon`, `style`, `starts_at`, `ends_at`, `enabled`, `sort`, `created_by`, `created_at`, `updated_at`) VALUES
	('server_autopilot', 'new', 'New', '#5865f2', '#ffffff', NULL, 'solid', NULL, 1802649600, 1, 0, 'system', unixepoch(), unixepoch()),
	('appeals', 'new', 'New', '#5865f2', '#ffffff', NULL, 'solid', NULL, 1795737600, 1, 0, 'system', unixepoch(), unixepoch()),
	('invite_tracker', 'new', 'New', '#5865f2', '#ffffff', NULL, 'solid', NULL, 1801440000, 1, 0, 'system', unixepoch(), unixepoch()),
	('team_control', 'new', 'New', '#5865f2', '#ffffff', NULL, 'solid', NULL, 1802649600, 1, 0, 'system', unixepoch(), unixepoch()),
	('message_kits', 'new', 'New', '#5865f2', '#ffffff', NULL, 'solid', NULL, 1802649600, 1, 0, 'system', unixepoch(), unixepoch());
