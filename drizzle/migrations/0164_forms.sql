-- Forms: Applications became one kind of form among many (RSVP, questionnaire, poll, feedback,
-- report, sign-up, custom). The plugin key and the `applications` table stay as they are, so
-- every existing application, opening, posted button and Dreamliner Roles grant keeps working;
-- these columns are additive and default to exactly what an application always was.
ALTER TABLE `applications` ADD `form_kind` text DEFAULT 'application' NOT NULL;
--> statement-breakpoint
ALTER TABLE `applications` ADD `anonymous` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `applications` ADD `rsvp` text;
--> statement-breakpoint
ALTER TABLE `applications` ADD `waitlisted` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `applications` ADD `updated_at` integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `applications_guild_opening` ON `applications` (`guild_id`, `opening_id`, `created_at`);
--> statement-breakpoint
-- RSVP reminders already sent, one row per event start, so a restart never sends one twice.
CREATE TABLE IF NOT EXISTS `form_reminders` (
	`guild_id` text NOT NULL,
	`opening_id` text NOT NULL,
	`starts_at` text NOT NULL,
	`sent_at` integer NOT NULL,
	PRIMARY KEY (`guild_id`, `opening_id`, `starts_at`)
);
