CREATE TABLE IF NOT EXISTS `impersonation_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`field` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`changed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `impersonation_history_guild_user` ON `impersonation_history` (`guild_id`, `user_id`, `changed_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `impersonation_watchlist` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`label` text NOT NULL,
	`target_user_id` text,
	`name` text DEFAULT '' NOT NULL,
	`avatar_hash` text,
	`added_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `impersonation_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`subject_user_id` text NOT NULL,
	`subject_username` text NOT NULL,
	`subject_avatar_url` text,
	`matched_user_id` text,
	`matched_watchlist_id` text,
	`matched_label` text NOT NULL,
	`matched_avatar_url` text,
	`trigger` text NOT NULL,
	`name_similarity` integer,
	`avatar_distance` integer,
	`auto_action` text,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `impersonation_alerts_guild_status_created` ON `impersonation_alerts` (`guild_id`, `status`, `created_at`);
