CREATE TABLE `bluesky_feeds` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `discord_channel_id` text NOT NULL,
  `did` text NOT NULL,
  `handle` text NOT NULL,
  `display_name` text DEFAULT '' NOT NULL,
  `avatar_url` text,
  `message_content` text DEFAULT '' NOT NULL,
  `mention_role_ids` text DEFAULT '[]' NOT NULL,
  `options` text NOT NULL,
  `last_post_at` integer,
  `enabled` integer DEFAULT 1 NOT NULL,
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bluesky_feeds_guild` ON `bluesky_feeds` (`guild_id`);
--> statement-breakpoint
CREATE INDEX `bluesky_feeds_did` ON `bluesky_feeds` (`did`);
--> statement-breakpoint
CREATE TABLE `bluesky_deliveries` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `feed_id` integer,
  `guild_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `message_id` text NOT NULL,
  `post_uri` text NOT NULL,
  `post_cid` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bluesky_deliveries_feed_post` ON `bluesky_deliveries` (`feed_id`, `post_uri`);
--> statement-breakpoint
CREATE INDEX `bluesky_deliveries_message` ON `bluesky_deliveries` (`message_id`);
--> statement-breakpoint
CREATE INDEX `bluesky_deliveries_created` ON `bluesky_deliveries` (`created_at`);
--> statement-breakpoint
CREATE TABLE `bluesky_accounts` (
  `discord_user_id` text PRIMARY KEY NOT NULL,
  `did` text NOT NULL,
  `handle` text NOT NULL,
  `display_name` text DEFAULT '' NOT NULL,
  `avatar_url` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bluesky_oauth_store` (
  `kind` text NOT NULL,
  `key` text NOT NULL,
  `value` text NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`kind`, `key`)
);
--> statement-breakpoint
CREATE TABLE `bluesky_actions` (
  `discord_user_id` text NOT NULL,
  `subject_uri` text NOT NULL,
  `kind` text NOT NULL,
  `record_uri` text NOT NULL,
  `created_at` integer NOT NULL,
  PRIMARY KEY(`discord_user_id`, `subject_uri`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `bluesky_stream_state` (
  `id` text PRIMARY KEY DEFAULT 'global' NOT NULL,
  `cursor` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
-- Default grants for the new plugin (see BUILT_IN_ROLE_GRANTS in src/config/permissionRoleDefaults.ts).
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'bluesky.can_use' FROM `guild_permission_roles` WHERE `built_in` = 'member';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'bluesky.can_view' FROM `guild_permission_roles` WHERE `built_in` = 'moderator';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'bluesky.can_manage' FROM `guild_permission_roles` WHERE `built_in` = 'moderator';
