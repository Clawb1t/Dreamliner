CREATE TABLE `guild_birthdays` (
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `month` integer NOT NULL,
  `day` integer NOT NULL,
  `year` integer,
  `set_by` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`guild_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `guild_birthdays_date` ON `guild_birthdays` (`month`, `day`);
