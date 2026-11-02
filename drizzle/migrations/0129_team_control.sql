-- Team Control (staff management).
--
-- 1. `team_members`: metadata for everyone who has held a rank role (Discord roles stay the source
--    of truth for who is on the team): joined date, suspensions with the roles to restore, trials.
-- 2. `team_shifts`, `team_leave`, `team_actions`, `team_notes`, `team_feedback`, `team_onboarding`.
-- 3. `team_activity_daily` (staff-channel messages per member per day), `team_roster_messages`,
--    `team_reports` and `team_inactivity_alerts` (what has already been posted).
-- 4. An index on mod_cases so each staff member's actions per period are a range scan.
-- 5. Built-in Dreamliner Roles get the new grants: Member can view the team and rate staff, Admin
--    gets everything else.
CREATE TABLE IF NOT EXISTS `team_members` (
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `joined_at` integer NOT NULL,
  `left_team_at` integer,
  `status` text DEFAULT 'active' NOT NULL,
  `rank_id` text,
  `suspended_until` integer,
  `suspended_role_ids` text DEFAULT '[]' NOT NULL,
  `trial_ends_at` integer,
  `trial_reviewed_at` integer,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`guild_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `team_members_guild_status` ON `team_members` (`guild_id`, `status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `team_shifts` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `type_id` text,
  `started_at` integer NOT NULL,
  `ended_at` integer,
  `break_seconds` integer DEFAULT 0 NOT NULL,
  `break_started_at` integer,
  `status` text DEFAULT 'active' NOT NULL,
  `ended_by` text,
  `edited_by` text,
  `note` text,
  `prev_nickname` text,
  `nick_applied` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `team_shifts_guild_user_started` ON `team_shifts` (`guild_id`, `user_id`, `started_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `team_shifts_guild_status` ON `team_shifts` (`guild_id`, `status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `team_leave` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `kind` text NOT NULL,
  `reason` text DEFAULT '' NOT NULL,
  `starts_at` integer NOT NULL,
  `ends_at` integer NOT NULL,
  `status` text NOT NULL,
  `reviewer_id` text,
  `review_reason` text,
  `decided_at` integer,
  `ended_at` integer,
  `review_channel_id` text,
  `review_message_id` text,
  `created_at` integer NOT NULL,
  `role_applied` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `team_leave_guild_status` ON `team_leave` (`guild_id`, `status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `team_leave_guild_user` ON `team_leave` (`guild_id`, `user_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `team_actions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `actor_id` text,
  `type` text NOT NULL,
  `from_rank_id` text,
  `to_rank_id` text,
  `reason` text DEFAULT '' NOT NULL,
  `expires_at` integer,
  `voided_at` integer,
  `voided_by` text,
  `void_reason` text,
  `auto` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `team_actions_guild_user_created` ON `team_actions` (`guild_id`, `user_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `team_actions_guild_created` ON `team_actions` (`guild_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `team_notes` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `author_id` text NOT NULL,
  `body` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `team_notes_guild_user` ON `team_notes` (`guild_id`, `user_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `team_feedback` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `staff_id` text NOT NULL,
  `rater_id` text NOT NULL,
  `rating` integer NOT NULL,
  `comment` text,
  `source` text NOT NULL,
  `ticket_id` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `team_feedback_guild_staff_created` ON `team_feedback` (`guild_id`, `staff_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `team_feedback_guild_rater` ON `team_feedback` (`guild_id`, `rater_id`, `staff_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `team_feedback_ticket` ON `team_feedback` (`guild_id`, `source`, `ticket_id`) WHERE source = 'ticket';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `team_onboarding` (
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `item_id` text NOT NULL,
  `done_by` text,
  `done_at` integer NOT NULL,
  PRIMARY KEY(`guild_id`, `user_id`, `item_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `team_activity_daily` (
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `day` text NOT NULL,
  `staff_messages` integer DEFAULT 0 NOT NULL,
  PRIMARY KEY(`guild_id`, `user_id`, `day`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `team_activity_daily_guild_day` ON `team_activity_daily` (`guild_id`, `day`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `team_roster_messages` (
  `guild_id` text PRIMARY KEY NOT NULL,
  `channel_id` text NOT NULL,
  `message_id` text NOT NULL,
  `fingerprint` text DEFAULT '' NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `team_reports` (
  `guild_id` text NOT NULL,
  `period_start` text NOT NULL,
  `posted_at` integer NOT NULL,
  PRIMARY KEY(`guild_id`, `period_start`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `team_inactivity_alerts` (
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `alerted_at` integer NOT NULL,
  PRIMARY KEY(`guild_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mod_cases_guild_mod_created` ON `mod_cases` (`guild_id`, `mod_id`, `created_at`);
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'team_control.can_view_team' FROM `guild_permission_roles` WHERE `built_in` = 'member';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'team_control.can_rate' FROM `guild_permission_roles` WHERE `built_in` = 'member';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'team_control.can_shift' FROM `guild_permission_roles` WHERE `built_in` = 'admin';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'team_control.can_request_leave' FROM `guild_permission_roles` WHERE `built_in` = 'admin';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'team_control.can_review_leave' FROM `guild_permission_roles` WHERE `built_in` = 'admin';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'team_control.can_discipline' FROM `guild_permission_roles` WHERE `built_in` = 'admin';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'team_control.can_promote' FROM `guild_permission_roles` WHERE `built_in` = 'admin';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'team_control.can_manage' FROM `guild_permission_roles` WHERE `built_in` = 'admin';
