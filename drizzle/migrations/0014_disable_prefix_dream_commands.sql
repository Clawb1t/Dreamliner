-- Prefix Dreamcode commands are no longer supported; disable any leftovers.
UPDATE `dream_commands` SET `enabled` = 0 WHERE `trigger_type` = 'prefix';
