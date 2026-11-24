-- Dreamliner Wrapped, the deeper stats: year-bounded per-user reads on tables that only had
-- guild-first indexes (tickets you opened, birthdays celebrated for you).
CREATE INDEX IF NOT EXISTS `tickets_opener_time` ON `tickets` (`opener_id`, `created_at`);
CREATE INDEX IF NOT EXISTS `birthday_celebrations_user_year` ON `birthday_celebrations` (`user_id`, `year`);
