-- First-run dashboard setup (bridge/webOnboarding.ts): per server, where the setup flow got to,
-- the answers given, who started/finished it, and when the one-time welcome message was sent.
CREATE TABLE IF NOT EXISTS `guild_onboarding` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`step` text,
	`answers_json` text,
	`started_by` text,
	`updated_by` text,
	`completed_by` text,
	`started_at` integer,
	`completed_at` integer,
	`welcome_sent_at` integer,
	`updated_at` integer NOT NULL
);
