-- Server-defined appeal options (e.g. "Minecraft server ban"): which one a manual appeal was sent through.
ALTER TABLE `appeals` ADD `option_id` text;
--> statement-breakpoint
ALTER TABLE `appeals` ADD `option_label` text;
