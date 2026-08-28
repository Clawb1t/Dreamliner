ALTER TABLE `tickets` ADD `last_staff_reply_at` integer;
--> statement-breakpoint
ALTER TABLE `tickets` ADD `escalation_step` integer DEFAULT -1 NOT NULL;
