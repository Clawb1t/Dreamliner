-- Navbar balance pill and Exchange dropdown item removed entirely (both were per-user opt-in
-- toggles, off by default).
ALTER TABLE `user_profiles` DROP COLUMN `show_nav_balance`;
ALTER TABLE `user_profiles` DROP COLUMN `show_nav_exchange`;
