CREATE TABLE IF NOT EXISTS `passport_network_signals` (
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `ip_address` text NOT NULL,
  `country` text,
  `region` text,
  `city` text,
  `verified_at` integer NOT NULL,
  PRIMARY KEY(`guild_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `passport_network_signals_guild`
  ON `passport_network_signals` (`guild_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `passport_alt_dismissals` (
  `guild_id` text NOT NULL,
  `user_id_a` text NOT NULL,
  `user_id_b` text NOT NULL,
  `dismissed_at` integer NOT NULL,
  `dismissed_by` text NOT NULL,
  PRIMARY KEY(`guild_id`, `user_id_a`, `user_id_b`)
);
