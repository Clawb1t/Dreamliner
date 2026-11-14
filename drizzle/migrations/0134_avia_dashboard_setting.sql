-- Account setting: show Avia, the help assistant, on dashboard pages (on by default).
ALTER TABLE `user_profiles` ADD COLUMN `avia_dashboard` integer DEFAULT 1 NOT NULL;
