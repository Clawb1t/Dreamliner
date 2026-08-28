-- Custom commands simplify to a single reply (text or embed, optionally randomized).
-- Per-command minimum level is dropped; every custom command is open to the whole server.
ALTER TABLE `dream_commands` DROP COLUMN `min_level`;
