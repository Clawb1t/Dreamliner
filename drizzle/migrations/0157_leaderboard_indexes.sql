-- Covering indexes for the leaderboards' heaviest queries, so they're answered from the index
-- alone instead of scanning (and sorting) whole tables.

-- Global and per-server Voice boards: SUM(seconds/minutes) GROUP BY user, optionally only days
-- before today (the frozen global board). Walks users in index order with the date and both
-- duration columns in the index, so no table lookups and no temporary sort.
CREATE INDEX IF NOT EXISTS `guild_stats_user_voice_daily_user_date_secs` ON `guild_stats_user_voice_daily` (`user_id`, `stat_date`, `seconds`, `minutes`);
CREATE INDEX IF NOT EXISTS `guild_stats_user_voice_daily_guild_user_secs` ON `guild_stats_user_voice_daily` (`guild_id`, `user_id`, `stat_date`, `seconds`, `minutes`);

-- Voice totals and daily voice charts.
CREATE INDEX IF NOT EXISTS `guild_stats_voice_daily_date_secs` ON `guild_stats_voice_daily` (`stat_date`, `seconds`, `minutes`);

-- Streak boards: live streaks (daily_streak > 0, claimed recently) ordered by streak.
CREATE INDEX IF NOT EXISTS `economy_global_accounts_streak` ON `economy_global_accounts` (`daily_streak`, `last_daily_at`);
CREATE INDEX IF NOT EXISTS `economy_server_accounts_guild_streak` ON `economy_server_accounts` (`guild_id`, `daily_streak`, `last_daily_at`);

-- Fresh planner statistics so SQLite actually picks the new indexes.
ANALYZE `guild_stats_user_voice_daily`;
ANALYZE `guild_stats_voice_daily`;
ANALYZE `economy_global_accounts`;
ANALYZE `economy_server_accounts`;
ANALYZE `user_message_counts`;
