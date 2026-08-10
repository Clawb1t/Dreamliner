CREATE TABLE IF NOT EXISTS guild_custom_charts (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  title TEXT NOT NULL,
  chart_type TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS guild_custom_charts_guild_sort_idx
  ON guild_custom_charts (guild_id, sort_order);
