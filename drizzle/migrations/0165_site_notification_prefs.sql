-- Website notifications: which kinds a user has muted in their settings (the bell skips them).
-- One row per user who changed anything; no row means nothing is muted. muted_kinds is a JSON array.
CREATE TABLE IF NOT EXISTS `site_notification_prefs` (
  `user_id` text PRIMARY KEY NOT NULL,
  `muted_kinds` text DEFAULT '[]' NOT NULL,
  `updated_at` integer NOT NULL
);
