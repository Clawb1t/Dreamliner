CREATE TABLE `ticket_ai_knowledge` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `kind` text NOT NULL,
  `status` text NOT NULL DEFAULT 'active',
  `title` text NOT NULL,
  `content` text NOT NULL,
  `source` text,
  `created_by` text,
  `uses` integer NOT NULL DEFAULT 0,
  `last_used_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ticket_ai_knowledge_guild_status` ON `ticket_ai_knowledge` (`guild_id`, `status`);
--> statement-breakpoint
CREATE INDEX `ticket_ai_knowledge_guild_kind` ON `ticket_ai_knowledge` (`guild_id`, `kind`);
--> statement-breakpoint
CREATE TABLE `ticket_ai_state` (
  `ticket_id` integer PRIMARY KEY NOT NULL,
  `guild_id` text NOT NULL,
  `mode` text NOT NULL DEFAULT 'ai',
  `ai_replies` integer NOT NULL DEFAULT 0,
  `reason` text,
  `changed_by` text,
  `escalated_at` integer,
  `learned_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ticket_ai_state_guild` ON `ticket_ai_state` (`guild_id`, `mode`);
--> statement-breakpoint
CREATE TABLE `ticket_ai_usage_daily` (
  `guild_id` text NOT NULL,
  `stat_date` text NOT NULL,
  `replies` integer NOT NULL DEFAULT 0,
  `background` integer NOT NULL DEFAULT 0,
  `escalations` integer NOT NULL DEFAULT 0,
  `resolved` integer NOT NULL DEFAULT 0,
  PRIMARY KEY (`guild_id`, `stat_date`)
);
--> statement-breakpoint
CREATE TABLE `ticket_ai_guild_state` (
  `guild_id` text PRIMARY KEY NOT NULL,
  `autotrain_last_run_at` integer,
  `autotrain_last_result` text,
  `updated_at` integer NOT NULL
);
