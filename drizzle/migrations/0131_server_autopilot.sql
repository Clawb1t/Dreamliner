-- Server Autopilot (AI server builder).
--
-- 1. `server_autopilot_generations`: walkthrough answers + the 3 generated templates (newest 15 per guild).
-- 2. `server_autopilot_builds`: build and restore jobs with live steps, errors and created ids.
-- 3. `server_autopilot_backups`: structure backups taken before every build (newest 10 per guild).
CREATE TABLE IF NOT EXISTS `server_autopilot_generations` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `answers` text NOT NULL,
  `templates` text DEFAULT '[]' NOT NULL,
  `status` text DEFAULT 'running' NOT NULL,
  `error` text,
  `progress` integer DEFAULT 0 NOT NULL,
  `charged` integer DEFAULT 0 NOT NULL,
  `created_by` text,
  `created_at` integer NOT NULL,
  `finished_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `server_autopilot_generations_guild` ON `server_autopilot_generations` (`guild_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `server_autopilot_builds` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `kind` text NOT NULL,
  `status` text DEFAULT 'queued' NOT NULL,
  `mode` text,
  `template_name` text,
  `generation_id` integer,
  `template` text,
  `naming` text,
  `keep` text,
  `options` text,
  `plan` text,
  `steps` text DEFAULT '[]' NOT NULL,
  `errors` text DEFAULT '[]' NOT NULL,
  `result` text,
  `id_map` text DEFAULT '{}' NOT NULL,
  `backup_id` integer,
  `cancel_requested` integer DEFAULT 0 NOT NULL,
  `created_by` text,
  `created_at` integer NOT NULL,
  `started_at` integer,
  `finished_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `server_autopilot_builds_guild` ON `server_autopilot_builds` (`guild_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `server_autopilot_builds_status` ON `server_autopilot_builds` (`status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `server_autopilot_backups` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `reason` text NOT NULL,
  `structure` text NOT NULL,
  `role_count` integer DEFAULT 0 NOT NULL,
  `channel_count` integer DEFAULT 0 NOT NULL,
  `config_snapshot_id` integer,
  `build_id` integer,
  `created_by` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `server_autopilot_backups_guild` ON `server_autopilot_backups` (`guild_id`, `created_at`);
