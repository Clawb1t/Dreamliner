ALTER TABLE `user_profiles` DROP COLUMN `content_retention_days`;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `evidence_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`capture_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`author_name` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`sent_at` integer NOT NULL,
	`captured_at` integer NOT NULL,
	`captured_by` text,
	`source` text NOT NULL,
	`case_id` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `evidence_messages_guild_user` ON `evidence_messages` (`guild_id`, `user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `evidence_messages_case` ON `evidence_messages` (`case_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `evidence_messages_capture` ON `evidence_messages` (`capture_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `case_evidence_files` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` integer NOT NULL,
	`guild_id` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`caption` text,
	`uploaded_by` text NOT NULL,
	`uploaded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `case_evidence_files_case` ON `case_evidence_files` (`case_id`);
--> statement-breakpoint
ALTER TABLE `mod_cases` ADD COLUMN `public` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `mod_cases` ADD COLUMN `share_token` text;
--> statement-breakpoint
ALTER TABLE `mod_cases` ADD COLUMN `public_note` text;
--> statement-breakpoint
ALTER TABLE `mod_cases` ADD COLUMN `published_at` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `mod_cases_share_token_unique` ON `mod_cases` (`share_token`);
