-- Reviews: staff replies, hiding (kept, but off Discord and out of the average) and featuring,
-- managed from the dashboard's View Reviews page (bridge/webReviews.ts).
ALTER TABLE `reviews` ADD `reply` text;
--> statement-breakpoint
ALTER TABLE `reviews` ADD `reply_by` text;
--> statement-breakpoint
ALTER TABLE `reviews` ADD `reply_at` integer;
--> statement-breakpoint
ALTER TABLE `reviews` ADD `hidden_at` integer;
--> statement-breakpoint
ALTER TABLE `reviews` ADD `hidden_by` text;
--> statement-breakpoint
ALTER TABLE `reviews` ADD `featured_at` integer;
--> statement-breakpoint
ALTER TABLE `reviews` ADD `featured_by` text;
--> statement-breakpoint
-- Applications activity log: staff notes (and later events) for one application, shown as the
-- timeline on the dashboard's application page (bridge/webApplications.ts).
CREATE TABLE `application_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` integer NOT NULL,
	`guild_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text,
	`content` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `application_events_application` ON `application_events` (`application_id`);
