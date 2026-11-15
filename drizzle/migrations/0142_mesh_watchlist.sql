-- Raid Defense Mesh watchlist: accounts named in a mesh alert this server received from a linked
-- server, remembered for a short window so a later join here can be flagged (raid_mesh/functions/watchlist.ts).
CREATE TABLE `raid_mesh_watchlist` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`source_guild_id` text NOT NULL,
	`source_guild_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `raid_mesh_watchlist_expires_idx` ON `raid_mesh_watchlist` (`expires_at`);
