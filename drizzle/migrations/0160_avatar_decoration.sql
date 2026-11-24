-- Public profile: show the user's own Discord avatar decoration over their avatar (website profile
-- and the /profile card). On by default; turned off in User Settings > Profile.
ALTER TABLE `user_profiles` ADD COLUMN `show_avatar_decoration` integer DEFAULT true NOT NULL;
