-- One-time maintenance jobs that have already run, so they never run twice (core/oneTimeTasks.ts).
CREATE TABLE `one_time_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`done_at` integer NOT NULL
);
