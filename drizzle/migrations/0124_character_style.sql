-- Characters: "How it talks" style controls (tone, emoji, formality, roleplay actions, catchphrases).
ALTER TABLE `characters` ADD `tone` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `characters` ADD `emoji_use` text NOT NULL DEFAULT 'some';
--> statement-breakpoint
ALTER TABLE `characters` ADD `formality` text NOT NULL DEFAULT 'balanced';
--> statement-breakpoint
ALTER TABLE `characters` ADD `roleplay_actions` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `characters` ADD `catchphrases` text NOT NULL DEFAULT '[]';
