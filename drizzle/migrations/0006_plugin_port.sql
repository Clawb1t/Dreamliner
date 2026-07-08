-- Plugin port: automod, censor, roles, content, tracking, misc

CREATE TABLE IF NOT EXISTS automod_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS censor_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  pattern TEXT NOT NULL,
  regex INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL DEFAULT 'delete',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mod_strikes (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS reaction_role_mappings (
  guild_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  role_id TEXT NOT NULL,
  remove_on_unreact INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (guild_id, message_id, emoji)
);

CREATE TABLE IF NOT EXISTS role_button_panels (
  guild_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  label TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT 'secondary',
  PRIMARY KEY (guild_id, message_id, role_id)
);

CREATE TABLE IF NOT EXISTS self_role_panels (
  guild_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  config TEXT NOT NULL,
  PRIMARY KEY (guild_id, message_id)
);

CREATE TABLE IF NOT EXISTS tags (
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, name)
);

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  content TEXT NOT NULL,
  cron_expr TEXT,
  next_run_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message TEXT NOT NULL,
  remind_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS persisted_messages (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS channel_autodelete (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  delay_seconds INTEGER NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS name_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  old_name TEXT NOT NULL,
  new_name TEXT NOT NULL,
  change_type TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS username_snapshots (
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id)
);

CREATE TABLE IF NOT EXISTS guild_stats_daily (
  guild_id TEXT NOT NULL,
  stat_date TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  joins INTEGER NOT NULL DEFAULT 0,
  leaves INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, stat_date)
);

CREATE TABLE IF NOT EXISTS custom_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  config TEXT NOT NULL,
  response TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS command_aliases (
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (guild_id, name)
);

CREATE TABLE IF NOT EXISTS counters (
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  value INTEGER NOT NULL DEFAULT 0,
  counter_type TEXT NOT NULL DEFAULT 'custom',
  PRIMARY KEY (guild_id, name)
);

CREATE TABLE IF NOT EXISTS companion_channels (
  guild_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, owner_id)
);

CREATE TABLE IF NOT EXISTS managed_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  template TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminders_remind_at ON reminders(remind_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_next ON scheduled_posts(next_run_at);
CREATE INDEX IF NOT EXISTS idx_name_history_user ON name_history(guild_id, user_id);
