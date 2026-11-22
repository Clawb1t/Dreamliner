-- Custom Commands v3: Shortcuts-style command builder.
--
-- 1. dream_commands keeps one row per (guild, name) and its `program` column, which now holds a
--    version 3 program: options, access rules, cooldowns, limits and an ordered list of steps.
--    New columns: owner_id (who first built it), last_editor_id (whose Discord permissions the
--    command runs with, re-checked on every run) and health_json (set when a run was refused
--    because that person lost a permission, cleared on the next save).
-- 2. Every version 2 program (one reply: text, random text or embed) becomes a version 3
--    program with one Reply step that keeps its text, variants, embed and ephemeral flag. Name,
--    description, enabled state and the command_usage_* history (keyed by name) are untouched,
--    so the command keeps working in Discord with no gap.
-- 3. dream_command_runs: the last runs of each command (who, when, result, failing step).
-- 4. dream_command_followups: buttons, select menus and forms a run posted, keyed by a random id
--    in the component custom id, with an expiry.
-- 5. dream_command_jobs: runs paused by a long Wait step, resumed by a 5 second poll.
-- 6. dream_command_daily_uses: per-user and per-server daily use counters for usage limits.
-- 7. dream_command_creations: channels and roles created by commands, for the per-server hourly cap.

ALTER TABLE `dream_commands` ADD `owner_id` text;
ALTER TABLE `dream_commands` ADD `last_editor_id` text;
ALTER TABLE `dream_commands` ADD `health_json` text;

UPDATE `dream_commands` SET `owner_id` = `created_by`, `last_editor_id` = `created_by`;

UPDATE `dream_commands`
SET `program` = json_object(
  'version', 3,
  'description', coalesce(json_extract(`program`, '$.description'), 'Custom command'),
  'ephemeral', json(CASE WHEN json_extract(`program`, '$.ephemeral') THEN 'true' ELSE 'false' END),
  'options', json('[]'),
  'access', json_object(
    'roles', json('[]'), 'rolesMode', 'any', 'blockedRoles', json('[]'), 'permissions', json('[]'),
    'channels', json('[]'), 'blockedChannels', json('[]'), 'visibility', json('[]')
  ),
  'cooldowns', json_object('user', 0, 'channel', 0, 'global', 0),
  'limits', json_object('perUserDaily', 0, 'guildDaily', 0),
  'steps', json_array(json_object(
    'id', 'step1',
    'type', 'reply',
    'config', json_object(
      'ephemeral', 'default',
      'message', json_object(
        'format', CASE WHEN json_extract(`program`, '$.responseType') = 'embed' THEN 'embed' ELSE 'text' END,
        'content', CASE
          WHEN json_extract(`program`, '$.responseType') = 'embed' THEN ''
          WHEN json_extract(`program`, '$.random') THEN ''
          ELSE coalesce(json_extract(`program`, '$.content'), '')
        END,
        'variants', CASE
          WHEN json_extract(`program`, '$.responseType') <> 'embed' AND json_extract(`program`, '$.random')
            THEN json(coalesce(json_extract(`program`, '$.variants'), '[]'))
          ELSE json('[]')
        END,
        'embed', json_object(
          'authorName', coalesce(json_extract(`program`, '$.embed.authorName'), ''),
          'authorIconUrl', coalesce(json_extract(`program`, '$.embed.authorIconUrl'), ''),
          'authorUrl', coalesce(json_extract(`program`, '$.embed.authorUrl'), ''),
          'title', coalesce(json_extract(`program`, '$.embed.title'), ''),
          'titleUrl', coalesce(json_extract(`program`, '$.embed.titleUrl'), ''),
          'description', coalesce(json_extract(`program`, '$.embed.description'), ''),
          'thumbnailUrl', coalesce(json_extract(`program`, '$.embed.thumbnailUrl'), ''),
          'imageUrl', coalesce(json_extract(`program`, '$.embed.imageUrl'), ''),
          'color', json_extract(`program`, '$.embed.color'),
          'footerText', coalesce(json_extract(`program`, '$.embed.footerText'), ''),
          'timestamp', json(CASE WHEN json_extract(`program`, '$.embed.timestamp') THEN 'true' ELSE 'false' END),
          'fields', json('[]')
        ),
        'container', json_object('accentColor', NULL, 'title', '', 'body', '', 'thumbnailUrl', '', 'imageUrl', '', 'footer', ''),
        'pings', json_object('runner', json('false'), 'optionUsers', json('false'), 'roles', json('[]'), 'everyone', json('false'))
      )
    )
  ))
)
WHERE json_valid(`program`) AND coalesce(json_extract(`program`, '$.version'), 2) = 2;

-- Old tokens: {mention} was the runner's mention; v3 calls it {user.mention}. {user}, {server}
-- and {channel} keep their names.
UPDATE `dream_commands` SET `program` = replace(`program`, '{mention}', '{user.mention}')
WHERE instr(`program`, '{mention}') > 0;

CREATE TABLE IF NOT EXISTS `dream_command_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`command_name` text NOT NULL,
	`user_id` text NOT NULL,
	`channel_id` text,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`steps` integer DEFAULT 0 NOT NULL,
	`failed_step_id` text,
	`error` text
);
CREATE INDEX IF NOT EXISTS `dream_command_runs_cmd` ON `dream_command_runs` (`guild_id`, `command_name`, `id`);
CREATE INDEX IF NOT EXISTS `dream_command_runs_started` ON `dream_command_runs` (`guild_id`, `started_at`);

CREATE TABLE IF NOT EXISTS `dream_command_followups` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`command_name` text NOT NULL,
	`kind` text NOT NULL,
	`message_id` text,
	`state` text NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS `dream_command_followups_guild` ON `dream_command_followups` (`guild_id`, `created_at`);
CREATE INDEX IF NOT EXISTS `dream_command_followups_expiry` ON `dream_command_followups` (`expires_at`);

CREATE TABLE IF NOT EXISTS `dream_command_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`command_name` text NOT NULL,
	`resume_at` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS `dream_command_jobs_due` ON `dream_command_jobs` (`resume_at`);

CREATE TABLE IF NOT EXISTS `dream_command_daily_uses` (
	`guild_id` text NOT NULL,
	`command_name` text NOT NULL,
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`guild_id`, `command_name`, `user_id`, `day`)
);

CREATE TABLE IF NOT EXISTS `dream_command_creations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS `dream_command_creations_guild` ON `dream_command_creations` (`guild_id`, `created_at`);
