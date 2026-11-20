-- Giveaways overhaul: message requirement, host/sponsor, recurring giveaways, Components V2 posts,
-- refundable entry costs, a per-draw fairness log, a timeline and a server blacklist.
ALTER TABLE `giveaways` ADD COLUMN `min_messages` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `giveaways` ADD COLUMN `host_id` text;
--> statement-breakpoint
ALTER TABLE `giveaways` ADD COLUMN `sponsor` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `giveaways` ADD COLUMN `recurrence` text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE `giveaways` ADD COLUMN `recurrence_parent_id` integer;
--> statement-breakpoint
ALTER TABLE `giveaways` ADD COLUMN `recurrence_next_id` integer;
--> statement-breakpoint
-- Posts made before this migration are classic embeds and keep being edited as embeds.
ALTER TABLE `giveaways` ADD COLUMN `message_format` text DEFAULT 'embed' NOT NULL;
--> statement-breakpoint
ALTER TABLE `giveaways` ADD COLUMN `announce_message_id` text;
--> statement-breakpoint
ALTER TABLE `giveaways` ADD COLUMN `last_error` text;
--> statement-breakpoint
ALTER TABLE `giveaways` ADD COLUMN `cancelled_at` integer;
--> statement-breakpoint
ALTER TABLE `giveaway_entries` ADD COLUMN `paid` real DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `giveaway_winners` ADD COLUMN `draw_id` integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `giveaway_draws` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`giveaway_id` integer NOT NULL,
	`kind` text NOT NULL,
	`seed` text,
	`pool_hash` text,
	`pool_size` integer DEFAULT 0 NOT NULL,
	`total_weight` real DEFAULT 0 NOT NULL,
	`picked_user_ids` text DEFAULT '[]' NOT NULL,
	`replaced_user_ids` text DEFAULT '[]' NOT NULL,
	`actor_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `giveaway_draws_giveaway` ON `giveaway_draws` (`giveaway_id`);
--> statement-breakpoint
-- One initial draw per giveaway, ever: ending twice (a restart mid-end, two ticks) can't draw twice.
CREATE UNIQUE INDEX IF NOT EXISTS `giveaway_draws_one_draw` ON `giveaway_draws` (`giveaway_id`) WHERE `kind` = 'draw';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `giveaway_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`giveaway_id` integer NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text,
	`detail` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `giveaway_events_giveaway` ON `giveaway_events` (`giveaway_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `giveaway_blacklist` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`reason` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`)
);
--> statement-breakpoint
-- Giveaways that already ended get a legacy draw row (no seed), so they're never drawn again and
-- the dashboard's draw log shows who the first draw picked.
INSERT INTO `giveaway_draws` (`giveaway_id`, `kind`, `seed`, `pool_hash`, `pool_size`, `total_weight`, `picked_user_ids`, `replaced_user_ids`, `actor_id`, `created_at`)
SELECT
	g.`id`,
	'draw',
	NULL,
	NULL,
	(SELECT COUNT(*) FROM `giveaway_entries` e WHERE e.`giveaway_id` = g.`id`),
	COALESCE((SELECT SUM(e.`weight`) FROM `giveaway_entries` e WHERE e.`giveaway_id` = g.`id`), 0),
	COALESCE((
		SELECT json_group_array(w.`user_id`) FROM `giveaway_winners` w
		WHERE w.`giveaway_id` = g.`id` AND w.`replaces_winner_id` IS NULL
			AND w.`selected_at` = (SELECT MIN(w2.`selected_at`) FROM `giveaway_winners` w2 WHERE w2.`giveaway_id` = g.`id`)
	), '[]'),
	'[]',
	NULL,
	COALESCE(g.`ended_at`, g.`updated_at`)
FROM `giveaways` g
WHERE g.`status` = 'ended'
	AND NOT EXISTS (SELECT 1 FROM `giveaway_draws` d WHERE d.`giveaway_id` = g.`id` AND d.`kind` = 'draw');
--> statement-breakpoint
UPDATE `giveaways` SET `cancelled_at` = `updated_at` WHERE `status` = 'cancelled' AND `cancelled_at` IS NULL;
