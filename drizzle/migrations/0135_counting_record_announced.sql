-- Counting: remember whether the new-record message was posted for the current run, so it fires once
-- per run instead of on every count past the old record. Runs already at their record count as announced.
ALTER TABLE `counting_channels` ADD COLUMN `record_announced` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `counting_channels` SET `record_announced` = 1 WHERE `total_resets` > 0 AND `current_count` >= `highest_count` AND `highest_count` > 0;
