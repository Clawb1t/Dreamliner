-- Public changelog (src/core/changelog/): one row per release window of bot commits, rewritten by
-- Autopilot into release notes. `commits_json` (messages, dates, product areas) is only ever shown to
-- platform operators; the website gets `content_json` for published rows. `generated_for` is the
-- commit-set key the content was written from, so a window is generated once unless regenerated.
CREATE TABLE IF NOT EXISTS `changelog_updates` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `slug` text NOT NULL,
  `window_start` integer NOT NULL,
  `window_end` integer NOT NULL,
  `commit_shas` text NOT NULL,
  `commits_json` text NOT NULL,
  `commit_count` integer NOT NULL DEFAULT 0,
  `content_json` text,
  `status` text NOT NULL DEFAULT 'draft',
  `model` text,
  `generated_for` text,
  `generated_at` integer,
  `generation_error` text,
  `edited_by` text,
  `edited_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `changelog_updates_slug_idx` ON `changelog_updates` (`slug`);
CREATE INDEX IF NOT EXISTS `changelog_updates_status_end_idx` ON `changelog_updates` (`status`, `window_end`);
