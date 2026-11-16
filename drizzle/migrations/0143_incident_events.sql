-- Incident Response activity log: staff notes, status changes, automatic responses and unlocks
-- for one incident, shown as the timeline on the dashboard's incident page (bridge/webIncidents.ts).
CREATE TABLE `incident_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`incident_id` integer NOT NULL,
	`guild_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text,
	`value` text,
	`content` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `incident_events_incident` ON `incident_events` (`incident_id`);
--> statement-breakpoint
CREATE INDEX `incident_events_guild_created` ON `incident_events` (`guild_id`,`created_at`);
