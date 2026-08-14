CREATE TABLE `companion_rooms` (
  `guild_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `owner_id` text NOT NULL DEFAULT '',
  `setup_id` text NOT NULL DEFAULT '',
  `text_channel_id` text NOT NULL DEFAULT '',
  `interface_message_id` text NOT NULL DEFAULT '',
  `locked` integer NOT NULL DEFAULT 0,
  `ghosted` integer NOT NULL DEFAULT 0,
  `seq` integer NOT NULL DEFAULT 0,
  PRIMARY KEY (`guild_id`, `channel_id`)
);
--> statement-breakpoint
INSERT INTO `companion_rooms` (`guild_id`, `channel_id`, `owner_id`)
  SELECT `guild_id`, `channel_id`, `owner_id` FROM `companion_channels`
  WHERE `owner_id` NOT LIKE 'hub:%';
--> statement-breakpoint
DROP TABLE `companion_channels`;
