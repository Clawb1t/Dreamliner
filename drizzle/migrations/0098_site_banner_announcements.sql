CREATE TABLE IF NOT EXISTS `site_banner_announcements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text DEFAULT 'info' NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`cta_label` text,
	`cta_url` text,
	`dismissible` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
