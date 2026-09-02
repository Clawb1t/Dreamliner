-- Dreamliner Roles: replaces the old level+override permission model.
CREATE TABLE IF NOT EXISTS `guild_permission_roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`name` text NOT NULL,
	`color` integer,
	`built_in` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `guild_permission_roles_guild` ON `guild_permission_roles` (`guild_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `guild_permission_role_targets` (
	`role_id` integer NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	PRIMARY KEY(`role_id`, `target_type`, `target_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `guild_permission_role_targets_role` ON `guild_permission_role_targets` (`role_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `guild_permission_role_grants` (
	`role_id` integer NOT NULL,
	`grant_key` text NOT NULL,
	PRIMARY KEY(`role_id`, `grant_key`)
);
