-- Notifications 2.0: one feeds engine for YouTube, Twitch, RSS/Atom, Steam, GitHub releases, status
-- pages and catalogue newswires. Every old YouTube/Twitch watcher becomes a source plus a
-- subscription (message, roles, embed card, options kept), the items they already announced are
-- stored as "baseline" items so nothing re-posts, the old deliveries are copied for stats, and the
-- old tables are dropped. Timestamps are unix seconds like the rest of the schema; JSON payload
-- times are milliseconds.
CREATE TABLE IF NOT EXISTS `feed_sources` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `type` text NOT NULL,
  `key` text NOT NULL,
  `config` text DEFAULT '{}' NOT NULL,
  `title` text DEFAULT '' NOT NULL,
  `icon_url` text,
  `site_url` text,
  `state` text DEFAULT '{}' NOT NULL,
  `etag` text,
  `last_modified` text,
  `content_hash` text,
  `next_check_at` integer NOT NULL,
  `interval_s` integer DEFAULT 900 NOT NULL,
  `fail_count` integer DEFAULT 0 NOT NULL,
  `last_error` text,
  `disabled_reason` text,
  `last_ok_at` integer,
  `last_checked_at` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `feed_sources_key` ON `feed_sources` (`key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `feed_sources_due` ON `feed_sources` (`next_check_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `feed_subscriptions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `source_id` integer NOT NULL,
  `channel_id` text NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `message` text DEFAULT '{}' NOT NULL,
  `mention_role_ids` text DEFAULT '[]' NOT NULL,
  `filters` text DEFAULT '{}' NOT NULL,
  `options` text DEFAULT '{}' NOT NULL,
  `cursor_item_id` integer DEFAULT 0 NOT NULL,
  `delivered_count` integer DEFAULT 0 NOT NULL,
  `legacy_ref` text,
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `feed_subscriptions_guild` ON `feed_subscriptions` (`guild_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `feed_subscriptions_source` ON `feed_subscriptions` (`source_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `feed_items` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `source_id` integer NOT NULL,
  `item_key` text NOT NULL,
  `title` text DEFAULT '' NOT NULL,
  `url` text DEFAULT '' NOT NULL,
  `image_url` text,
  `summary` text DEFAULT '' NOT NULL,
  `author` text,
  `tags` text DEFAULT '[]' NOT NULL,
  `published_at` integer,
  `first_seen_at` integer NOT NULL,
  `baseline` integer DEFAULT 0 NOT NULL,
  `payload` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `feed_items_source_key` ON `feed_items` (`source_id`, `item_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `feed_items_source_id` ON `feed_items` (`source_id`, `id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `feed_deliveries` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `subscription_id` integer NOT NULL,
  `item_id` integer NOT NULL,
  `guild_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `message_id` text,
  `status` text NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `error` text,
  `payload` text DEFAULT '{}' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `feed_deliveries_sub_item` ON `feed_deliveries` (`subscription_id`, `item_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `feed_deliveries_guild_created` ON `feed_deliveries` (`guild_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `feed_deliveries_sub_created` ON `feed_deliveries` (`subscription_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `feed_deliveries_created` ON `feed_deliveries` (`created_at`);
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- YouTube watchers -> sources. The newest watcher row for a channel supplies the profile. The
-- baseline watermark makes the first fetch treat every upload published at or before the newest
-- checkpoint as already seen, while anything newer still posts.
-- ---------------------------------------------------------------------------------------------
INSERT OR IGNORE INTO `feed_sources` (`type`, `key`, `config`, `title`, `icon_url`, `site_url`, `state`, `next_check_at`, `interval_s`, `created_at`)
SELECT
  'youtube',
  'youtube:' || w.`source_channel_id`,
  json_object('channelId', w.`source_channel_id`, 'uploadsPlaylistId', w.`uploads_playlist_id`, 'handle', w.`source_channel_handle`),
  w.`source_channel_name`,
  w.`source_channel_avatar_url`,
  w.`source_channel_url`,
  CASE
    WHEN (SELECT max(x.`last_video_published_at`) FROM `social_youtube_watchers` x WHERE x.`source_channel_id` = w.`source_channel_id`) IS NULL THEN '{}'
    ELSE json_object('baselineBefore', (SELECT max(x.`last_video_published_at`) FROM `social_youtube_watchers` x WHERE x.`source_channel_id` = w.`source_channel_id`) * 1000)
  END,
  0,
  300,
  w.`created_at`
FROM `social_youtube_watchers` w
ORDER BY w.`updated_at` DESC, w.`id` DESC;
--> statement-breakpoint
INSERT INTO `feed_subscriptions` (`guild_id`, `source_id`, `channel_id`, `enabled`, `message`, `mention_role_ids`, `filters`, `options`, `cursor_item_id`, `delivered_count`, `legacy_ref`, `created_by`, `created_at`, `updated_at`)
SELECT
  w.`guild_id`,
  s.`id`,
  w.`discord_channel_id`,
  w.`enabled`,
  json_object(
    'content', w.`message_content`,
    'embed', CASE WHEN json_valid(w.`embed_config`) THEN json_remove(json(w.`embed_config`), '$.buttons') ELSE json('{}') END,
    'buttons', CASE
      WHEN json_valid(w.`embed_config`) AND coalesce(json_extract(w.`embed_config`, '$.enabled'), 0) AND json_type(w.`embed_config`, '$.buttons') = 'array'
        THEN json_extract(w.`embed_config`, '$.buttons')
      ELSE json('[]')
    END
  ),
  CASE WHEN json_valid(w.`mention_role_ids`) THEN w.`mention_role_ids` ELSE '[]' END,
  json_object(
    'youtube_videos', json(CASE WHEN json_valid(w.`options`) AND json_extract(w.`options`, '$.notify_videos') = 0 THEN 'false' ELSE 'true' END),
    'youtube_shorts', json(CASE WHEN json_valid(w.`options`) AND json_extract(w.`options`, '$.notify_shorts') = 0 THEN 'false' ELSE 'true' END),
    'youtube_live', json(CASE WHEN json_valid(w.`options`) AND json_extract(w.`options`, '$.notify_live') = 0 THEN 'false' ELSE 'true' END)
  ),
  CASE WHEN json_valid(w.`options`) THEN json_remove(json(w.`options`), '$.notify_videos', '$.notify_shorts', '$.notify_live') ELSE '{}' END,
  0,
  w.`delivered_count`,
  'youtube:' || w.`id`,
  w.`created_by`,
  w.`created_at`,
  w.`updated_at`
FROM `social_youtube_watchers` w
JOIN `feed_sources` s ON s.`key` = 'youtube:' || w.`source_channel_id`;
--> statement-breakpoint
-- Each watcher's checkpoint video, so it never posts again even if it's still the newest upload.
INSERT OR IGNORE INTO `feed_items` (`source_id`, `item_key`, `title`, `url`, `image_url`, `published_at`, `first_seen_at`, `baseline`, `payload`)
SELECT
  s.`id`,
  w.`last_video_id`,
  '',
  'https://www.youtube.com/watch?v=' || w.`last_video_id`,
  'https://i.ytimg.com/vi/' || w.`last_video_id` || '/hqdefault.jpg',
  w.`last_video_published_at`,
  coalesce(w.`last_checked_at`, w.`updated_at`),
  1,
  '{}'
FROM `social_youtube_watchers` w
JOIN `feed_sources` s ON s.`key` = 'youtube:' || w.`source_channel_id`
WHERE w.`last_video_id` IS NOT NULL AND w.`last_video_id` != '';
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Twitch watchers -> sources. The live-session state moves to the source (it's the same stream
-- for every server); the stream id each watcher last announced becomes a baseline item.
-- ---------------------------------------------------------------------------------------------
INSERT OR IGNORE INTO `feed_sources` (`type`, `key`, `config`, `title`, `icon_url`, `site_url`, `state`, `next_check_at`, `interval_s`, `last_ok_at`, `created_at`)
SELECT
  'twitch',
  'twitch:' || w.`source_user_id`,
  json_object('userId', w.`source_user_id`, 'login', w.`source_user_login`),
  w.`source_user_display_name`,
  w.`source_user_avatar_url`,
  w.`source_user_url`,
  json_object(
    'lastSeenLiveAt', (SELECT max(x.`last_seen_live_at`) FROM `social_twitch_watchers` x WHERE x.`source_user_id` = w.`source_user_id`) * 1000,
    'streamId', (SELECT x.`last_stream_id` FROM `social_twitch_watchers` x WHERE x.`source_user_id` = w.`source_user_id` AND x.`last_stream_id` IS NOT NULL ORDER BY x.`last_live_at` DESC LIMIT 1)
  ),
  0,
  120,
  w.`last_checked_at`,
  w.`created_at`
FROM `social_twitch_watchers` w
ORDER BY w.`updated_at` DESC, w.`id` DESC;
--> statement-breakpoint
INSERT INTO `feed_subscriptions` (`guild_id`, `source_id`, `channel_id`, `enabled`, `message`, `mention_role_ids`, `filters`, `options`, `cursor_item_id`, `delivered_count`, `legacy_ref`, `created_by`, `created_at`, `updated_at`)
SELECT
  w.`guild_id`,
  s.`id`,
  w.`discord_channel_id`,
  w.`enabled`,
  json_object(
    'content', w.`message_content`,
    'embed', CASE WHEN json_valid(w.`embed_config`) THEN json_remove(json(w.`embed_config`), '$.buttons') ELSE json('{}') END,
    'buttons', CASE
      WHEN json_valid(w.`embed_config`) AND coalesce(json_extract(w.`embed_config`, '$.enabled'), 0) AND json_type(w.`embed_config`, '$.buttons') = 'array'
        THEN json_extract(w.`embed_config`, '$.buttons')
      ELSE json('[]')
    END
  ),
  CASE WHEN json_valid(w.`mention_role_ids`) THEN w.`mention_role_ids` ELSE '[]' END,
  '{}',
  CASE WHEN json_valid(w.`options`) THEN json_remove(json(w.`options`), '$.notify_videos', '$.notify_shorts', '$.notify_live') ELSE '{}' END,
  0,
  w.`delivered_count`,
  'twitch:' || w.`id`,
  w.`created_by`,
  w.`created_at`,
  w.`updated_at`
FROM `social_twitch_watchers` w
JOIN `feed_sources` s ON s.`key` = 'twitch:' || w.`source_user_id`;
--> statement-breakpoint
INSERT OR IGNORE INTO `feed_items` (`source_id`, `item_key`, `title`, `url`, `published_at`, `first_seen_at`, `baseline`, `payload`)
SELECT
  s.`id`,
  w.`last_stream_id`,
  '',
  w.`source_user_url`,
  w.`last_live_at`,
  coalesce(w.`last_checked_at`, w.`updated_at`),
  1,
  '{}'
FROM `social_twitch_watchers` w
JOIN `feed_sources` s ON s.`key` = 'twitch:' || w.`source_user_id`
WHERE w.`last_stream_id` IS NOT NULL AND w.`last_stream_id` != '';
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Old deliveries -> items (baseline, so they're deduped) + deliveries (stats, Twitch sessions).
-- ---------------------------------------------------------------------------------------------
INSERT INTO `feed_items` (`source_id`, `item_key`, `title`, `url`, `image_url`, `published_at`, `first_seen_at`, `baseline`, `payload`)
SELECT
  sub.`source_id`,
  d.`item_id`,
  d.`title`,
  d.`url`,
  d.`thumbnail_url`,
  coalesce(d.`started_at`, d.`created_at`),
  d.`created_at`,
  1,
  json_object('kind', d.`kind`, 'gameName', d.`game_name`)
FROM `social_deliveries` d
JOIN `feed_subscriptions` sub ON sub.`legacy_ref` = d.`platform` || ':' || d.`watcher_id`
WHERE true
ON CONFLICT (`source_id`, `item_key`) DO UPDATE SET
  `title` = CASE WHEN `feed_items`.`title` = '' THEN excluded.`title` ELSE `feed_items`.`title` END,
  `image_url` = coalesce(`feed_items`.`image_url`, excluded.`image_url`),
  `payload` = CASE WHEN `feed_items`.`payload` = '{}' THEN excluded.`payload` ELSE `feed_items`.`payload` END;
--> statement-breakpoint
INSERT OR IGNORE INTO `feed_deliveries` (`subscription_id`, `item_id`, `guild_id`, `channel_id`, `message_id`, `status`, `attempts`, `payload`, `created_at`, `updated_at`)
SELECT
  sub.`id`,
  i.`id`,
  d.`guild_id`,
  d.`channel_id`,
  d.`message_id`,
  'sent',
  1,
  json_object(
    'kind', d.`kind`,
    'title', d.`title`,
    'gameName', d.`game_name`,
    'peakViewers', d.`peak_viewers`,
    'startedAt', d.`started_at` * 1000,
    'endedAt', CASE WHEN d.`platform` = 'twitch' THEN d.`ended_at` * 1000 ELSE NULL END
  ),
  d.`created_at`,
  d.`created_at`
FROM `social_deliveries` d
JOIN `feed_subscriptions` sub ON sub.`legacy_ref` = d.`platform` || ':' || d.`watcher_id`
JOIN `feed_items` i ON i.`source_id` = sub.`source_id` AND i.`item_key` = d.`item_id`
ORDER BY d.`id`;
--> statement-breakpoint
DROP TABLE IF EXISTS `social_deliveries`;
--> statement-breakpoint
DROP TABLE IF EXISTS `social_youtube_watchers`;
--> statement-breakpoint
DROP TABLE IF EXISTS `social_twitch_watchers`;
