CREATE TABLE `bot_guild_profiles` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`bio` text,
	`updated_at` integer NOT NULL,
	`updated_by` text
);

ALTER TABLE `bot_avatar_requests` ADD COLUMN `kind` text NOT NULL DEFAULT 'avatar';
