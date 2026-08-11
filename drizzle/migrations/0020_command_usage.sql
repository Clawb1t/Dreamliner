CREATE TABLE `command_usage_daily` (
	`guild_id` text NOT NULL,
	`command_name` text NOT NULL,
	`stat_date` text NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`guild_id`, `command_name`, `stat_date`)
);

CREATE TABLE `command_usage_totals` (
	`guild_id` text NOT NULL,
	`command_name` text NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`guild_id`, `command_name`)
);

CREATE INDEX `command_usage_daily_date_idx` ON `command_usage_daily` (`stat_date`);
CREATE INDEX `command_usage_totals_uses_idx` ON `command_usage_totals` (`uses`);
