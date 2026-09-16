CREATE TABLE IF NOT EXISTS `voice_clips` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`duration_ms` integer NOT NULL,
	`file_name` text NOT NULL,
	`byte_size` integer NOT NULL,
	`privacy` text DEFAULT 'public' NOT NULL,
	`password_hash` text,
	`keep_forever` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`edited_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `voice_clips_owner` ON `voice_clips` (`owner_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `voice_clips_expires` ON `voice_clips` (`expires_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `voice_clip_participants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`clip_id` text NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`username` text NOT NULL,
	`avatar_url` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `voice_clip_participants_clip` ON `voice_clip_participants` (`clip_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `voice_clip_participants_user` ON `voice_clip_participants` (`user_id`);
