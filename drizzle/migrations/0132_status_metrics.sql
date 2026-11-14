-- Public status page: per-minute process health next to the existing ping/servers/RAM samples.
-- All nullable, so rows recorded before this migration simply have no value.
ALTER TABLE `bot_status_samples` ADD COLUMN `cpu_pct` real;
--> statement-breakpoint
ALTER TABLE `bot_status_samples` ADD COLUMN `event_loop_ms` real;
--> statement-breakpoint
ALTER TABLE `bot_status_samples` ADD COLUMN `heap_used_mb` integer;
--> statement-breakpoint
ALTER TABLE `bot_status_samples` ADD COLUMN `commands` integer;
