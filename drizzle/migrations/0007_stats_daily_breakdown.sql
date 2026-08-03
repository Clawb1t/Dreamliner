-- Per-user and per-channel daily activity for stats graphs

CREATE TABLE IF NOT EXISTS guild_stats_user_daily (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  stat_date TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, stat_date)
);

CREATE TABLE IF NOT EXISTS guild_stats_channel_daily (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  stat_date TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, channel_id, stat_date)
);

CREATE INDEX IF NOT EXISTS idx_guild_stats_user_daily_lookup
  ON guild_stats_user_daily (guild_id, user_id, stat_date);

CREATE INDEX IF NOT EXISTS idx_guild_stats_channel_daily_lookup
  ON guild_stats_channel_daily (guild_id, channel_id, stat_date);
