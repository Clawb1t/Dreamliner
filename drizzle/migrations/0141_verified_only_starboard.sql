-- Part two of 0141 (member journey). Activity Rewards starboard-post milestones: who wrote each
-- starboarded message. Older rows stay null until their star count next changes.
ALTER TABLE `starboard_posts` ADD `author_id` text;
--> statement-breakpoint
CREATE INDEX `starboard_posts_guild_author` ON `starboard_posts` (`guild_id`,`author_id`);
