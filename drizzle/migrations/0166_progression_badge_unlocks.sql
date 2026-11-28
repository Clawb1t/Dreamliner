-- Progression badges: when each user first reached each tier (the badge window's "Unlocked" date).
-- Filled in as badges are resolved. Tiers a user already held when tracking began are stored with
-- a null date, since nobody knows when they were really reached.
CREATE TABLE IF NOT EXISTS `user_progression_badge_unlocks` (
  `user_id` text NOT NULL,
  `badge_key` text NOT NULL,
  `tier` integer NOT NULL,
  `unlocked_at` integer,
  PRIMARY KEY (`user_id`, `badge_key`, `tier`)
);

-- Per-user lookups for the new badge stats (forms submitted, custom commands built).
CREATE INDEX IF NOT EXISTS `applications_user_status` ON `applications` (`user_id`, `status`);
CREATE INDEX IF NOT EXISTS `dream_commands_created_by` ON `dream_commands` (`created_by`);
