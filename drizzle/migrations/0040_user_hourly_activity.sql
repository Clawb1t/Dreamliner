CREATE TABLE `user_hourly_activity` (
	`user_id` text NOT NULL,
	`hour_utc` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `hour_utc`)
);
