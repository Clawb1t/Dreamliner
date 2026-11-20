-- Quizzes: dashboard-built graded and personality quizzes, solo attempts with per-question answers
-- (for analytics and leaderboards), live trivia games with players and answers, and a timeline.
CREATE TABLE IF NOT EXISTS `quizzes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`kind` text DEFAULT 'graded' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`cover_image_url` text DEFAULT '' NOT NULL,
	`color` integer,
	`category` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`outcomes` text DEFAULT '[]' NOT NULL,
	`opens_at` integer,
	`closes_at` integer,
	`panel_channel_id` text,
	`panel_message_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`published_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `quizzes_guild` ON `quizzes` (`guild_id`, `status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `quizzes_schedule` ON `quizzes` (`status`, `opens_at`, `closes_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `quiz_questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`quiz_id` integer NOT NULL,
	`guild_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`type` text DEFAULT 'single' NOT NULL,
	`prompt` text NOT NULL,
	`image_url` text DEFAULT '' NOT NULL,
	`explanation` text DEFAULT '' NOT NULL,
	`points` integer DEFAULT 1 NOT NULL,
	`time_limit_sec` integer DEFAULT 0 NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`accepted` text DEFAULT '[]' NOT NULL,
	`number_answer` real,
	`number_tolerance` real DEFAULT 0 NOT NULL,
	`partial_credit` integer DEFAULT 0 NOT NULL,
	`typo_tolerance` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `quiz_questions_quiz` ON `quiz_questions` (`quiz_id`, `position`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `quiz_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`quiz_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'in_progress' NOT NULL,
	`seed` text NOT NULL,
	`question_order` text DEFAULT '[]' NOT NULL,
	`current_index` integer DEFAULT 0 NOT NULL,
	`question_started_at` integer,
	`awaiting_next` integer DEFAULT 0 NOT NULL,
	`score` real DEFAULT 0 NOT NULL,
	`max_score` real DEFAULT 0 NOT NULL,
	`percent` real DEFAULT 0 NOT NULL,
	`passed` integer,
	`outcome_id` text,
	`correct_count` integer DEFAULT 0 NOT NULL,
	`streak` integer DEFAULT 0 NOT NULL,
	`best_streak` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`deadline_at` integer,
	`finished_at` integer,
	`duration_ms` integer,
	`reward_role_id` text
);
--> statement-breakpoint
-- Per-quiz leaderboard: best score, then fastest.
CREATE INDEX IF NOT EXISTS `quiz_attempts_leaderboard` ON `quiz_attempts` (`quiz_id`, `status`, `score`, `duration_ms`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `quiz_attempts_member` ON `quiz_attempts` (`guild_id`, `user_id`, `quiz_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `quiz_attempts_guild_time` ON `quiz_attempts` (`guild_id`, `started_at`);
--> statement-breakpoint
-- One unfinished attempt per member per quiz: pressing Start twice resumes instead of starting two.
CREATE UNIQUE INDEX IF NOT EXISTS `quiz_attempts_one_open` ON `quiz_attempts` (`quiz_id`, `user_id`) WHERE `status` = 'in_progress';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `quiz_attempt_answers` (
	`attempt_id` integer NOT NULL,
	`question_id` integer NOT NULL,
	`quiz_id` integer NOT NULL,
	`guild_id` text NOT NULL,
	`position` integer NOT NULL,
	`answer` text DEFAULT '{}' NOT NULL,
	`correct` integer,
	`credit` real DEFAULT 0 NOT NULL,
	`points` real DEFAULT 0 NOT NULL,
	`time_ms` integer DEFAULT 0 NOT NULL,
	`late` integer DEFAULT 0 NOT NULL,
	`timed_out` integer DEFAULT 0 NOT NULL,
	`answered_at` integer NOT NULL,
	PRIMARY KEY(`attempt_id`, `question_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `quiz_attempt_answers_question` ON `quiz_attempt_answers` (`quiz_id`, `question_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `quiz_live_games` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`quiz_id` integer NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text,
	`host_id` text NOT NULL,
	`status` text DEFAULT 'lobby' NOT NULL,
	`question_order` text DEFAULT '[]' NOT NULL,
	`option_orders` text DEFAULT '{}' NOT NULL,
	`current_index` integer DEFAULT -1 NOT NULL,
	`question_started_at` integer,
	`phase_ends_at` integer,
	`question_seconds` integer DEFAULT 20 NOT NULL,
	`reveal_seconds` integer DEFAULT 6 NOT NULL,
	`speed_bonus` integer DEFAULT 1 NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`end_reason` text
);
--> statement-breakpoint
-- One live game per channel at a time.
CREATE UNIQUE INDEX IF NOT EXISTS `quiz_live_games_one_per_channel` ON `quiz_live_games` (`channel_id`) WHERE `status` IN ('lobby', 'question', 'reveal');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `quiz_live_games_guild` ON `quiz_live_games` (`guild_id`, `started_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `quiz_live_players` (
	`game_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`correct_count` integer DEFAULT 0 NOT NULL,
	`answered_count` integer DEFAULT 0 NOT NULL,
	`streak` integer DEFAULT 0 NOT NULL,
	`best_streak` integer DEFAULT 0 NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `quiz_live_answers` (
	`game_id` integer NOT NULL,
	`question_index` integer NOT NULL,
	`user_id` text NOT NULL,
	`option_id` text NOT NULL,
	`correct` integer DEFAULT 0 NOT NULL,
	`points` integer DEFAULT 0 NOT NULL,
	`time_ms` integer DEFAULT 0 NOT NULL,
	`answered_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `question_index`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `quiz_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`quiz_id` integer NOT NULL,
	`guild_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text,
	`detail` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `quiz_events_quiz` ON `quiz_events` (`quiz_id`, `created_at`);

--> statement-breakpoint
-- Built-in Dreamliner Roles in existing servers get the new grants (new servers get them from BUILT_IN_ROLE_GRANTS).
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'quizzes.can_take' FROM `guild_permission_roles` WHERE `built_in` = 'member';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'quizzes.can_host_live' FROM `guild_permission_roles` WHERE `built_in` = 'moderator';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'quizzes.can_view_results' FROM `guild_permission_roles` WHERE `built_in` = 'moderator';
--> statement-breakpoint
INSERT OR IGNORE INTO `guild_permission_role_grants` (`role_id`, `grant_key`)
SELECT `id`, 'quizzes.can_manage' FROM `guild_permission_roles` WHERE `built_in` = 'admin';
