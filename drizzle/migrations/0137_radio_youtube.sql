-- Dreamliner Radio: stations now play YouTube videos (resolved once through Lavalink) instead of
-- uploaded MP3s. Older MP3 rows stay but have no encoded track, so they're skipped until deleted.
ALTER TABLE `radio_tracks` ADD COLUMN `source_url` text;
--> statement-breakpoint
ALTER TABLE `radio_tracks` ADD COLUMN `encoded` text;
--> statement-breakpoint
ALTER TABLE `radio_tracks` ADD COLUMN `artwork_url` text;
