-- Message Kits (saved messages built on the dashboard).
--
-- 1. `message_kits`: the library (KitDocument JSON per kit) and `message_kit_versions` (newest 25).
-- 2. `message_kit_posts`: every message a kit was sent as, so sync can edit it in place.
-- 3. `message_kit_schedules`: one-off and recurring sends.
-- 4. `message_kit_assets`: uploaded images/files (bytes on disk under data/guild-assets).
-- 5. Built-in Dreamliner Roles: Moderator and Admin can send, Admin can manage.
CREATE TABLE IF NOT EXISTS `message_kits` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `name` text NOT NULL,
  `folder` text DEFAULT '' NOT NULL,
  `description` text DEFAULT '' NOT NULL,
  `document` text NOT NULL,
  `version` integer DEFAULT 1 NOT NULL,
  `archived` integer DEFAULT 0 NOT NULL,
  `created_by` text,
  `updated_by` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `message_kits_guild_folder` ON `message_kits` (`guild_id`, `folder`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `message_kits_guild_updated` ON `message_kits` (`guild_id`, `updated_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `message_kit_versions` (
  `kit_id` integer NOT NULL,
  `version` integer NOT NULL,
  `document` text NOT NULL,
  `saved_by` text,
  `saved_at` integer NOT NULL,
  `note` text DEFAULT '' NOT NULL,
  PRIMARY KEY(`kit_id`, `version`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `message_kit_posts` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `kit_id` integer,
  `channel_id` text NOT NULL,
  `thread_id` text,
  `message_id` text NOT NULL,
  `via` text NOT NULL,
  `webhook_id` text,
  `format` text DEFAULT 'classic' NOT NULL,
  `kit_version` integer NOT NULL,
  `posted_by` text,
  `posted_at` integer NOT NULL,
  `last_synced_at` integer,
  `deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `message_kit_posts_message` ON `message_kit_posts` (`message_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `message_kit_posts_guild_kit` ON `message_kit_posts` (`guild_id`, `kit_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `message_kit_schedules` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `kit_id` integer NOT NULL,
  `channel_id` text NOT NULL,
  `thread_id` text,
  `next_run_at` integer,
  `repeat` text DEFAULT 'none' NOT NULL,
  `time_of_day` text NOT NULL,
  `timezone` text NOT NULL,
  `weekday` integer,
  `month_day` integer,
  `replace_previous` integer DEFAULT 0 NOT NULL,
  `last_post_id` integer,
  `enabled` integer DEFAULT 1 NOT NULL,
  `last_run_at` integer,
  `last_error` text,
  `fail_count` integer DEFAULT 0 NOT NULL,
  `created_by` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `message_kit_schedules_guild` ON `message_kit_schedules` (`guild_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `message_kit_schedules_due` ON `message_kit_schedules` (`enabled`, `next_run_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `message_kit_assets` (
  `id` text PRIMARY KEY NOT NULL,
  `guild_id` text NOT NULL,
  `filename` text NOT NULL,
  `content_type` text NOT NULL,
  `size` integer NOT NULL,
  `sha256` text NOT NULL,
  `created_by` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `message_kit_assets_guild` ON `message_kit_assets` (`guild_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'message_kits.can_send' FROM `guild_permission_roles` WHERE `built_in` = 'moderator';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'message_kits.can_send' FROM `guild_permission_roles` WHERE `built_in` = 'admin';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'message_kits.can_manage' FROM `guild_permission_roles` WHERE `built_in` = 'admin';
