CREATE TABLE `tickets` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `guild_id` text NOT NULL,
  `panel_id` text NOT NULL,
  `category_id` text NOT NULL,
  `number` integer NOT NULL,
  `channel_id` text NOT NULL,
  `thread_id` text,
  `mode` text DEFAULT 'channel' NOT NULL,
  `opener_id` text NOT NULL,
  `claimed_by` text,
  `status` text DEFAULT 'open' NOT NULL,
  `priority` text DEFAULT 'medium' NOT NULL,
  `form_responses` text DEFAULT '[]' NOT NULL,
  `member_ids` text DEFAULT '[]' NOT NULL,
  `created_at` integer NOT NULL,
  `closed_at` integer,
  `closed_by` text,
  `close_reason` text,
  `last_activity_at` integer NOT NULL,
  `rating_score` integer,
  `rating_comment` text
);
--> statement-breakpoint
CREATE TABLE `ticket_transcripts` (
  `id` text PRIMARY KEY NOT NULL,
  `ticket_id` integer NOT NULL,
  `guild_id` text NOT NULL,
  `created_at` integer NOT NULL,
  `payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ticket_blacklist` (
  `guild_id` text NOT NULL,
  `target_id` text NOT NULL,
  `target_type` text NOT NULL,
  `reason` text,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`guild_id`, `target_id`)
);
