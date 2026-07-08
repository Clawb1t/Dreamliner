ALTER TABLE `mod_cases` ADD COLUMN `active` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `mod_cases` ADD COLUMN `expires_at` integer;
--> statement-breakpoint
ALTER TABLE `mod_cases` ADD COLUMN `metadata` text;
