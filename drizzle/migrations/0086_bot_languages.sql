CREATE TABLE `bot_languages` (
  `code` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `flag` text DEFAULT '' NOT NULL,
  `enabled` integer DEFAULT true NOT NULL,
  `built_in` integer DEFAULT false NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bot_translations` (
  `locale` text NOT NULL,
  `key` text NOT NULL,
  `value` text NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`locale`, `key`)
);
