CREATE TABLE `appeals` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `case_id` integer,
  `kind` text NOT NULL,
  `infraction_type` text,
  `case_snapshot_json` text,
  `form_id` text NOT NULL DEFAULT '',
  `form_name` text NOT NULL DEFAULT '',
  `answers_json` text NOT NULL,
  `status` text NOT NULL DEFAULT 'pending',
  `reviewer_id` text,
  `decision_reason` text,
  `reversed` integer NOT NULL DEFAULT 0,
  `reversal_note` text,
  `review_channel_id` text,
  `review_message_id` text,
  `thread_id` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `appeals_guild_status` ON `appeals` (`guild_id`, `status`);
--> statement-breakpoint
CREATE INDEX `appeals_guild_user` ON `appeals` (`guild_id`, `user_id`);
--> statement-breakpoint
CREATE INDEX `appeals_case` ON `appeals` (`case_id`);
--> statement-breakpoint
CREATE TABLE `appeal_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `appeal_id` integer NOT NULL,
  `kind` text NOT NULL,
  `actor_id` text,
  `body` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `appeal_events_appeal` ON `appeal_events` (`appeal_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'appeals.can_review' FROM `guild_permission_roles` WHERE `built_in` = 'moderator';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'appeals.can_view' FROM `guild_permission_roles` WHERE `built_in` = 'moderator';
