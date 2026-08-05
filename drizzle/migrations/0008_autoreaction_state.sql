CREATE TABLE IF NOT EXISTS autoreaction_state (
  guild_id TEXT NOT NULL,
  rule_id INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_triggered_at INTEGER,
  PRIMARY KEY (guild_id, rule_id, channel_id)
);
