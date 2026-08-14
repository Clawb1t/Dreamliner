CREATE TABLE `persisted_messages_new` (
  `guild_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `message_id` text NOT NULL,
  PRIMARY KEY (`guild_id`, `channel_id`)
);
--> statement-breakpoint
INSERT INTO `persisted_messages_new` (`guild_id`, `channel_id`, `message_id`)
  SELECT `guild_id`, `channel_id`, `message_id` FROM `persisted_messages`;
--> statement-breakpoint
DROP TABLE `persisted_messages`;
--> statement-breakpoint
ALTER TABLE `persisted_messages_new` RENAME TO `persisted_messages`;
