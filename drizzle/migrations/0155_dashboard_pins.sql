-- Dashboard sidebar favourites (bridge/webDashboardPins.ts): per user, per server, an ordered
-- JSON array of the section ids pinned to the top of that server's dashboard sidebar.
CREATE TABLE IF NOT EXISTS `dashboard_pins` (
	`user_id` text NOT NULL,
	`guild_id` text NOT NULL,
	`pins` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `guild_id`)
);
