-- Custom commands move from a text script (`source`) to a JSON program (`program`).
-- Existing saved commands are reset (approved) rather than migrated.
DELETE FROM `dream_commands`;
--> statement-breakpoint
ALTER TABLE `dream_commands` DROP COLUMN `trigger_type`;
--> statement-breakpoint
ALTER TABLE `dream_commands` DROP COLUMN `source`;
--> statement-breakpoint
ALTER TABLE `dream_commands` ADD COLUMN `program` text NOT NULL DEFAULT '{}';
