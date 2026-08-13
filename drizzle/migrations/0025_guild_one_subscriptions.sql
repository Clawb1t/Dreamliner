CREATE TABLE `guild_one_subscriptions` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`expires_at` integer,
	`note` text,
	`granted_by` text NOT NULL,
	`granted_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`revoked_at` integer
);
