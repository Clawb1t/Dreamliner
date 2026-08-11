CREATE TABLE `bot_status_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sampled_at` integer NOT NULL,
	`ok` integer DEFAULT 1 NOT NULL,
	`ws_ping_ms` integer
);

CREATE INDEX `bot_status_samples_sampled_at_idx` ON `bot_status_samples` (`sampled_at`);

CREATE TABLE `bot_status_daily` (
	`stat_date` text PRIMARY KEY NOT NULL,
	`up_samples` integer DEFAULT 0 NOT NULL,
	`down_samples` integer DEFAULT 0 NOT NULL,
	`ping_sum` integer DEFAULT 0 NOT NULL,
	`ping_count` integer DEFAULT 0 NOT NULL,
	`ping_max` integer DEFAULT 0 NOT NULL
);
