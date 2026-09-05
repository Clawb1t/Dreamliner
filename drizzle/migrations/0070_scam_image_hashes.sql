-- Global (not per-guild) perceptual-hash blocklist for the Image Scanning automod rule.
-- Managed only from the platform superuser dashboard (/dashboard/scam-images).
CREATE TABLE IF NOT EXISTS `scam_image_hashes` (
	`id` text PRIMARY KEY NOT NULL,
	`phash` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`added_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `scam_image_hashes_phash` ON `scam_image_hashes` (`phash`);
