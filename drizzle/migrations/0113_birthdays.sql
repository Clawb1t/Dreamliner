CREATE TABLE `user_birthdays` (
  `user_id` text PRIMARY KEY NOT NULL,
  `month` integer NOT NULL,
  `day` integer NOT NULL,
  `year` integer,
  `timezone` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `user_birthdays_date` ON `user_birthdays` (`month`, `day`);
--> statement-breakpoint
CREATE TABLE `birthday_optouts` (
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `created_at` integer NOT NULL,
  PRIMARY KEY(`guild_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `birthday_celebrations` (
  `guild_id` text NOT NULL,
  `user_id` text NOT NULL,
  `year` integer NOT NULL,
  `celebrated_at` integer NOT NULL,
  `channel_id` text,
  `message_id` text,
  `role_id` text,
  `role_expires_at` integer,
  `role_removed_at` integer,
  `delete_at` integer,
  `deleted_at` integer,
  PRIMARY KEY(`guild_id`, `user_id`, `year`)
);
--> statement-breakpoint
CREATE INDEX `birthday_celebrations_message` ON `birthday_celebrations` (`message_id`);
--> statement-breakpoint
CREATE TABLE `birthday_wishes` (
  `message_id` text NOT NULL,
  `user_id` text NOT NULL,
  `created_at` integer NOT NULL,
  PRIMARY KEY(`message_id`, `user_id`)
);
