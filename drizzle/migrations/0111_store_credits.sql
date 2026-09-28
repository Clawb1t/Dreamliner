CREATE TABLE `store_votes` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` text NOT NULL,
  `voted_at` integer NOT NULL,
  `topgg_vote_id` text,
  `weight` integer DEFAULT 1 NOT NULL,
  `source` text NOT NULL,
  `credited_at` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `store_votes_user_time` ON `store_votes` (`user_id`, `voted_at`);
--> statement-breakpoint
CREATE INDEX `store_votes_user_credited` ON `store_votes` (`user_id`, `credited_at`);
--> statement-breakpoint
CREATE TABLE `store_credit_ledger` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` text NOT NULL,
  `delta` integer NOT NULL,
  `kind` text NOT NULL,
  `vote_id` integer,
  `guild_id` text,
  `days` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `store_credit_ledger_user` ON `store_credit_ledger` (`user_id`, `created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `store_credit_ledger_vote` ON `store_credit_ledger` (`vote_id`);
--> statement-breakpoint
CREATE TABLE `store_vote_sync` (
  `id` integer PRIMARY KEY NOT NULL,
  `last_vote_at` integer,
  `last_synced_at` integer,
  `last_error` text
);
