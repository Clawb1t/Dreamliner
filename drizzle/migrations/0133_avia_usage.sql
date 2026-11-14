-- Avia (help centre AI assistant): messages per subject per UTC day, for daily limits.
-- subject is "user:<discordId>", "ip:<salted hash>" (never a raw IP) or "*" for the global total.
CREATE TABLE `avia_usage` (
	`subject` text NOT NULL,
	`day` text NOT NULL,
	`messages` integer DEFAULT 0 NOT NULL,
	`tokens` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`subject`, `day`)
);
--> statement-breakpoint
CREATE INDEX `avia_usage_day` ON `avia_usage` (`day`);
