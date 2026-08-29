DROP TABLE `tts_user_voices`;
--> statement-breakpoint
CREATE TABLE `tts_user_voices` (
  `user_id` text PRIMARY KEY NOT NULL,
  `voice` text NOT NULL
);
