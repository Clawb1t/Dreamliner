-- Ghost Mode and cross-server privacy.
--
-- 1. Ghost Mode: a per-user (global, not per-server) privacy switch on user_profiles, with an
--    optional expiry (ghost_until, null = until turned off) and a "hide from global leaderboards"
--    switch that works on its own. Ghost Mode only changes what OTHER people can see: every stat,
--    streak, voice minute and coin is still tracked exactly as before.
-- 2. ghost_mode_allowlist: people who still see a user's live data while Ghost Mode is on.
-- 3. Day-start snapshots: when someone views ANOTHER user's global numbers they see the value as of
--    00:00 UTC today, never the live one, so polling can't tell whether that person is active in
--    some other server right now. The triggers below copy the old value the first time a row
--    changes on a new UTC day, which covers every writer without touching the hot paths.
-- 4. global_board_snapshots: the global leaderboards, frozen once per UTC day.

ALTER TABLE `user_profiles` ADD `ghost_mode` integer DEFAULT 0 NOT NULL;
ALTER TABLE `user_profiles` ADD `ghost_until` integer;
ALTER TABLE `user_profiles` ADD `ghost_hide_leaderboards` integer DEFAULT 0 NOT NULL;

CREATE TABLE IF NOT EXISTS `ghost_mode_allowlist` (
	`user_id` text NOT NULL,
	`viewer_id` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `viewer_id`)
);
CREATE INDEX IF NOT EXISTS `ghost_mode_allowlist_viewer` ON `ghost_mode_allowlist` (`viewer_id`);

ALTER TABLE `user_message_counts` ADD `day_start_count` integer;
ALTER TABLE `user_message_counts` ADD `day_start_last_at` integer;
ALTER TABLE `user_message_counts` ADD `day_start_date` text;

ALTER TABLE `user_hourly_activity` ADD `day_start_count` integer;
ALTER TABLE `user_hourly_activity` ADD `day_start_date` text;

ALTER TABLE `economy_global_accounts` ADD `day_start_balance` real;
ALTER TABLE `economy_global_accounts` ADD `day_start_streak` integer;
ALTER TABLE `economy_global_accounts` ADD `day_start_last_daily_at` integer;
ALTER TABLE `economy_global_accounts` ADD `day_start_date` text;

-- A brand-new row starts the day at zero.
CREATE TRIGGER IF NOT EXISTS `user_message_counts_day_start_insert`
AFTER INSERT ON `user_message_counts`
BEGIN
	UPDATE `user_message_counts`
	SET `day_start_count` = 0, `day_start_last_at` = NULL, `day_start_date` = date('now')
	WHERE `user_id` = NEW.`user_id`;
END;

-- First change on a new UTC day: remember the value it had at 00:00.
CREATE TRIGGER IF NOT EXISTS `user_message_counts_day_start_update`
AFTER UPDATE OF `count` ON `user_message_counts`
WHEN OLD.`day_start_date` IS NULL OR OLD.`day_start_date` < date('now')
BEGIN
	UPDATE `user_message_counts`
	SET `day_start_count` = OLD.`count`, `day_start_last_at` = OLD.`last_message_at`, `day_start_date` = date('now')
	WHERE `user_id` = NEW.`user_id`;
END;

CREATE TRIGGER IF NOT EXISTS `user_hourly_activity_day_start_insert`
AFTER INSERT ON `user_hourly_activity`
BEGIN
	UPDATE `user_hourly_activity`
	SET `day_start_count` = 0, `day_start_date` = date('now')
	WHERE `user_id` = NEW.`user_id` AND `hour_utc` = NEW.`hour_utc`;
END;

CREATE TRIGGER IF NOT EXISTS `user_hourly_activity_day_start_update`
AFTER UPDATE OF `count` ON `user_hourly_activity`
WHEN OLD.`day_start_date` IS NULL OR OLD.`day_start_date` < date('now')
BEGIN
	UPDATE `user_hourly_activity`
	SET `day_start_count` = OLD.`count`, `day_start_date` = date('now')
	WHERE `user_id` = NEW.`user_id` AND `hour_utc` = NEW.`hour_utc`;
END;

CREATE TRIGGER IF NOT EXISTS `economy_global_accounts_day_start_insert`
AFTER INSERT ON `economy_global_accounts`
BEGIN
	UPDATE `economy_global_accounts`
	SET `day_start_balance` = 0, `day_start_streak` = 0, `day_start_last_daily_at` = NULL, `day_start_date` = date('now')
	WHERE `user_id` = NEW.`user_id`;
END;

CREATE TRIGGER IF NOT EXISTS `economy_global_accounts_day_start_update`
AFTER UPDATE OF `balance`, `daily_streak`, `last_daily_at` ON `economy_global_accounts`
WHEN OLD.`day_start_date` IS NULL OR OLD.`day_start_date` < date('now')
BEGIN
	UPDATE `economy_global_accounts`
	SET `day_start_balance` = OLD.`balance`, `day_start_streak` = OLD.`daily_streak`,
		`day_start_last_daily_at` = OLD.`last_daily_at`, `day_start_date` = date('now')
	WHERE `user_id` = NEW.`user_id`;
END;

CREATE TABLE IF NOT EXISTS `global_board_snapshots` (
	`board` text PRIMARY KEY NOT NULL,
	`snapshot_date` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
