ALTER TABLE `store_votes` ADD `reminder_sent_at` integer;
--> statement-breakpoint
CREATE TABLE `vote_reminder_prefs` (
  `user_id` text PRIMARY KEY NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `updated_at` integer NOT NULL
);
