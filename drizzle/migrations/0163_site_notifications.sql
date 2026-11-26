-- Website notifications: the bell in the site's navbar. Superusers write them; the audience (JSON)
-- is matched when a user reads their notifications, so nothing is fanned out per user. The state
-- table only holds what a user did themselves (first seen, read, dismissed), all unix ms.
CREATE TABLE IF NOT EXISTS `site_notifications` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `kind` text DEFAULT 'announcement' NOT NULL,
  `title` text NOT NULL,
  `body` text DEFAULT '' NOT NULL,
  `link_url` text,
  `link_label` text,
  `icon` text,
  `audience` text NOT NULL,
  `status` text DEFAULT 'draft' NOT NULL,
  `pinned` integer DEFAULT 0 NOT NULL,
  `published_at` integer,
  `expires_at` integer,
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS `site_notifications_status` ON `site_notifications` (`status`, `published_at`);

CREATE TABLE IF NOT EXISTS `site_notification_state` (
  `user_id` text NOT NULL,
  `notification_id` integer NOT NULL,
  `seen_at` integer,
  `read_at` integer,
  `dismissed_at` integer,
  PRIMARY KEY (`user_id`, `notification_id`)
);
CREATE INDEX IF NOT EXISTS `site_notification_state_notification` ON `site_notification_state` (`notification_id`);
