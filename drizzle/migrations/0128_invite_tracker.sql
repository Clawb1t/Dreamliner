-- Invite Tracker.
--
-- 1. `invite_joins` holds one row per member join and is the source of truth for every invite
--    count (regular - left - fake + bonus, always summed from these rows). `counted` is 0 for a
--    rejoin under `rejoin_policy: ignore`.
-- 2. `invite_bonus` (net manual adjustments) and `invite_resets` (soft-reset cutoffs per inviter,
--    `*` for the whole server).
-- 3. `invite_tracked_links`: bot-created invites that record where members came from, soft-deleted
--    so their stats survive.
-- 4. `invite_daily_stats`: joins past `retention_days` folded into per-day totals.
-- 5. Built-in Dreamliner Roles get the new grants: Member can view, Moderator can pause invites,
--    Admin can manage.
CREATE TABLE IF NOT EXISTS `invite_joins` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `member_id` text NOT NULL,
  `inviter_id` text,
  `code` text,
  `source` text NOT NULL,
  `tracked_link_id` integer,
  `joined_at` integer NOT NULL,
  `left_at` integer,
  `status` text NOT NULL,
  `fake_reason` text,
  `counted` integer DEFAULT 1 NOT NULL,
  `account_created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invite_joins_guild_inviter_status` ON `invite_joins` (`guild_id`, `inviter_id`, `status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invite_joins_guild_member_joined` ON `invite_joins` (`guild_id`, `member_id`, `joined_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invite_joins_guild_joined` ON `invite_joins` (`guild_id`, `joined_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invite_joins_guild_link` ON `invite_joins` (`guild_id`, `tracked_link_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `invite_bonus` (
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `amount` integer DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`guild_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `invite_resets` (
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `reset_at` integer NOT NULL,
  PRIMARY KEY(`guild_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `invite_tracked_links` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `code` text NOT NULL,
  `name` text NOT NULL,
  `channel_id` text NOT NULL,
  `role_ids` text DEFAULT '[]' NOT NULL,
  `max_uses` integer DEFAULT 0 NOT NULL,
  `max_age` integer DEFAULT 0 NOT NULL,
  `created_by` text,
  `created_at` integer NOT NULL,
  `deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `invite_tracked_links_code` ON `invite_tracked_links` (`code`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invite_tracked_links_guild` ON `invite_tracked_links` (`guild_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `invite_daily_stats` (
  `guild_id` text NOT NULL,
  `day` text NOT NULL,
  `source` text NOT NULL,
  `tracked_link_id` integer DEFAULT 0 NOT NULL,
  `joins` integer DEFAULT 0 NOT NULL,
  `leaves` integer DEFAULT 0 NOT NULL,
  `fakes` integer DEFAULT 0 NOT NULL,
  PRIMARY KEY(`guild_id`, `day`, `source`, `tracked_link_id`)
);
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'invite_tracker.can_view' FROM `guild_permission_roles` WHERE `built_in` = 'member';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'invite_tracker.can_view_others' FROM `guild_permission_roles` WHERE `built_in` = 'member';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'invite_tracker.can_raid' FROM `guild_permission_roles` WHERE `built_in` = 'moderator';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'invite_tracker.can_manage' FROM `guild_permission_roles` WHERE `built_in` = 'admin';
