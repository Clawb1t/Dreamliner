-- Older databases can hold NULL balances and streaks: the NOT NULL constraint was added to the
-- schema later, and SQLite doesn't backfill existing rows. NULL broke the Hangar's coin display.
UPDATE `economy_global_accounts` SET `balance` = 0 WHERE `balance` IS NULL;
--> statement-breakpoint
UPDATE `economy_global_accounts` SET `daily_streak` = 0 WHERE `daily_streak` IS NULL;
--> statement-breakpoint
UPDATE `economy_server_accounts` SET `balance` = 0 WHERE `balance` IS NULL;
--> statement-breakpoint
UPDATE `economy_server_accounts` SET `daily_streak` = 0 WHERE `daily_streak` IS NULL;
