-- Characters: AI roleplay characters made on the dashboard, one mentionable role each.
CREATE TABLE `characters` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `name` text NOT NULL,
  `avatar_asset_id` text,
  `avatar_url` text,
  `tagline` text NOT NULL DEFAULT '',
  `personality` text NOT NULL DEFAULT '',
  `scenario` text NOT NULL DEFAULT '',
  `greeting` text NOT NULL DEFAULT '',
  `example_dialogue` text NOT NULL DEFAULT '',
  `reply_style` text NOT NULL DEFAULT 'medium',
  `temperature` real NOT NULL DEFAULT 0.9,
  `role_id` text,
  `role_color` integer,
  `dedicated_channel_ids` text NOT NULL DEFAULT '[]',
  `allowed_channel_ids` text NOT NULL DEFAULT '[]',
  `enabled` integer NOT NULL DEFAULT 1,
  `review_status` text NOT NULL DEFAULT 'approved',
  `review_reason` text,
  `reviewed_at` integer,
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `characters_guild` ON `characters` (`guild_id`);
--> statement-breakpoint
CREATE INDEX `characters_guild_role` ON `characters` (`guild_id`, `role_id`);
--> statement-breakpoint
CREATE TABLE `character_memory_resets` (
  `character_id` integer NOT NULL,
  `channel_id` text NOT NULL,
  `reset_at` integer NOT NULL,
  PRIMARY KEY (`character_id`, `channel_id`)
);
--> statement-breakpoint
CREATE TABLE `characters_usage_daily` (
  `guild_id` text NOT NULL,
  `day` text NOT NULL,
  `replies` integer NOT NULL DEFAULT 0,
  `tokens_in` integer NOT NULL DEFAULT 0,
  `tokens_out` integer NOT NULL DEFAULT 0,
  PRIMARY KEY (`guild_id`, `day`)
);
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'characters.can_talk' FROM `guild_permission_roles` WHERE `built_in` = 'member';
