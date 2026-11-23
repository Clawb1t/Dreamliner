-- Public leaderboards: the last complete copy of every board, so a restart serves boards instantly
-- instead of rebuilding them cold (src/bridge/leaderboardCache.ts).
CREATE TABLE IF NOT EXISTS `leaderboard_cache` (
  `key` text PRIMARY KEY NOT NULL,
  `payload` text NOT NULL,
  `built_at` integer NOT NULL
);

-- Durable Discord identity cache (name, avatar, banner) for leaderboard rows, so a row never has to
-- wait on a Discord lookup once the user has been seen (src/bridge/identityStore.ts). `gone` marks a
-- deleted or unknown account; `fetched_at` is the last full API fetch (0 = only seen in the
-- gateway cache, banner not known yet).
CREATE TABLE IF NOT EXISTS `user_identity_cache` (
  `user_id` text PRIMARY KEY NOT NULL,
  `username` text,
  `global_name` text,
  `avatar` text,
  `banner` text,
  `gone` integer NOT NULL DEFAULT 0,
  `fetched_at` integer NOT NULL DEFAULT 0,
  `updated_at` integer NOT NULL
);

-- The once-a-day frozen global boards are gone: boards now serve the most recent build.
DROP TABLE IF EXISTS `global_board_snapshots`;
