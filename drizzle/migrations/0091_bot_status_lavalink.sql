ALTER TABLE `bot_status_samples` ADD COLUMN `lavalink_players` integer;
--> statement-breakpoint
ALTER TABLE `bot_status_samples` ADD COLUMN `lavalink_playing_players` integer;
--> statement-breakpoint
ALTER TABLE `bot_status_samples` ADD COLUMN `lavalink_memory_used_mb` integer;
--> statement-breakpoint
ALTER TABLE `bot_status_samples` ADD COLUMN `lavalink_cpu_load_pct` real;
