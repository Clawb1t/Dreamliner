-- Public profile opt-in: show the plane/airline trading card collection. Off by default.
ALTER TABLE `user_profiles` ADD COLUMN `show_trading_cards` integer DEFAULT 0 NOT NULL;
