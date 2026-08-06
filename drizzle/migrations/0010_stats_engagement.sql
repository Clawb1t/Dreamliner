ALTER TABLE `guild_stats_daily` ADD COLUMN `edits` integer DEFAULT 0 NOT NULL;
ALTER TABLE `guild_stats_daily` ADD COLUMN `deletes` integer DEFAULT 0 NOT NULL;
ALTER TABLE `guild_stats_daily` ADD COLUMN `reactions` integer DEFAULT 0 NOT NULL;
ALTER TABLE `guild_stats_daily` ADD COLUMN `attachments` integer DEFAULT 0 NOT NULL;
