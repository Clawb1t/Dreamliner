CREATE TABLE IF NOT EXISTS `incidents` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `entity_type` text NOT NULL,
  `entity_id` text NOT NULL,
  `severity` text DEFAULT 'low' NOT NULL,
  `risk_score` integer DEFAULT 0 NOT NULL,
  `status` text DEFAULT 'open' NOT NULL,
  `title` text NOT NULL,
  `signal_count` integer DEFAULT 0 NOT NULL,
  `source_count` integer DEFAULT 0 NOT NULL,
  `responded_severity` text,
  `actions_taken` text DEFAULT '[]' NOT NULL,
  `first_signal_at` integer NOT NULL,
  `last_signal_at` integer NOT NULL,
  `resolved_by` text,
  `resolved_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `incidents_guild_status` ON `incidents` (`guild_id`, `status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `incidents_guild_entity` ON `incidents` (`guild_id`, `entity_type`, `entity_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `incident_signals` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `incident_id` integer NOT NULL,
  `guild_id` text NOT NULL,
  `source` text NOT NULL,
  `signal_type` text NOT NULL,
  `weight` integer NOT NULL,
  `entity_type` text NOT NULL,
  `entity_id` text NOT NULL,
  `secondary_entity_type` text,
  `secondary_entity_id` text,
  `reason` text NOT NULL,
  `detail` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `incident_signals_incident` ON `incident_signals` (`incident_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `incident_signals_guild_created` ON `incident_signals` (`guild_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `incident_lockdowns` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `incident_id` integer,
  `previous_overwrite` text NOT NULL,
  `locked_at` integer NOT NULL,
  `locked_by` text NOT NULL,
  `unlock_at` integer,
  `unlocked_at` integer,
  `unlocked_by` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `incident_lockdowns_guild` ON `incident_lockdowns` (`guild_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `incident_lockdowns_unlock_at` ON `incident_lockdowns` (`unlock_at`);
