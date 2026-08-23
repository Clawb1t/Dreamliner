CREATE TABLE `role_panel_messages` (
  `guild_id` text NOT NULL,
  `panel_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `message_id` text NOT NULL,
  `post_mode` text NOT NULL,
  `fingerprint` text NOT NULL DEFAULT '',
  `applied_role_ids` text NOT NULL DEFAULT '[]',
  PRIMARY KEY (`guild_id`, `panel_id`)
);
