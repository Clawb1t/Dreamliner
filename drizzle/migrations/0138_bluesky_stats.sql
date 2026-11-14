-- Bluesky: per-feed stats for the dashboard. An all-time delivered counter on each feed (deliveries
-- are pruned after 180 days, so it can't be counted from them forever), seeded from the deliveries
-- still on record, and net Like / Repost presses from Discord on each delivered card.
ALTER TABLE `bluesky_feeds` ADD COLUMN `delivered_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `bluesky_feeds` SET `delivered_count` = (
  SELECT count(*) FROM `bluesky_deliveries` WHERE `bluesky_deliveries`.`feed_id` = `bluesky_feeds`.`id`
);
--> statement-breakpoint
ALTER TABLE `bluesky_deliveries` ADD COLUMN `like_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `bluesky_deliveries` ADD COLUMN `repost_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `bluesky_deliveries_guild_created` ON `bluesky_deliveries` (`guild_id`, `created_at`);
