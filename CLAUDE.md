# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Dreamliner is a Discord moderation/ops bot (discord.js v14 + TypeScript, ESM, Node >= 20). Per-guild config is
YAML, deep-merged with defaults and stored in SQLite (drizzle-orm + better-sqlite3). A separate website
(dreamliner.site, not in this repo) provides a config editor and dashboard; it talks to the bot only through a
small authenticated HTTP bridge in `src/bridge/`. `dashboard/` and `src/dashboard/` are empty local scaffolding —
the actual dashboard frontend lives in a different project.

## Commands

```bash
npm run dev                # tsx watch src/index.ts — local bot process
npm run build               # tsc -p tsconfig.build.json -> dist/ (prebuild runs version bump + schema/catalog export)
npm run start                # node main.js (wrapper, used by panel hosts)
npm run start:prod           # node dist/index.js
npm run typecheck            # tsc --noEmit
npm test                     # tsx --test src/**/*.test.ts (Node's built-in test runner)
npm run register-commands    # tsx src/scripts/register-commands.ts — push slash/context-menu commands to Discord
npm run db:generate          # drizzle-kit generate — new migration from src/db/schema.ts changes
npm run db:migrate           # tsx src/scripts/migrate.ts — apply drizzle/migrations/*.sql
npm run schema:export        # regenerate schema/guild-config.schema.json from the zod config schemas
npm run dreamcode:export     # regenerate docs/dreamcode/actions.catalog.json from the action catalog
```

Run a single test file directly, e.g.:
```bash
npx tsx --test src/core/userRegex.test.ts
```

There is no lint script/config in this repo — `typecheck` is the correctness gate.

`.env` needs at least `DISCORD_TOKEN`; see `.env.example` for the rest (dashboard bridge, Dreamliner Aero SKU,
etc.). `DATABASE_URL` defaults to `file:./data/dreamliner.db`.

## Architecture

### Boot sequence
`src/index.ts` → optionally exports the guild-config JSON schema (local dev / `EXPORT_SCHEMA_ON_START`) → runs
pending drizzle migrations → registers application commands with Discord (unless
`REGISTER_COMMANDS_ON_START=false`) → `createBot()` in `src/bot.ts` builds the `Client`, loads plugins, and wires
a single `InteractionCreate` listener that dispatches to whichever plugin owns the command/component.

### Plugin system
Everything user-facing is a **plugin** (`src/plugins/<name>/`), shaped by `DreamlinerPlugin` in
`src/core/types.ts` and built with `definePlugin()` (`src/core/plugin.ts`):
- `name`, `configSchema` (zod), `defaultOverrides`, `dependencies`
- `slashCommands` / `contextMenuCommands` — each carries its own `plugin`, optional `permission` (a `can_*`
  flag name), `manageServer`, `discordPermissions`, and `execute(ctx)`
- `events` — discord.js event handlers registered per-plugin
- `onLoad(ctx)` — one-time setup when the bot boots

All plugins are registered in `src/plugins/availablePlugins.ts`; add a new plugin there. `src/core/pluginLoader.ts`
flattens every plugin's commands/events into the shared `BotContext` (`commands`, `contextMenuCommands`,
`interactionStore`) and wraps each event handler so a thrown error is logged, not fatal.

A typical plugin directory: `index.ts` (definePlugin + export), `commands.ts` (SlashCommandDefinition[]),
`defaultOverrides.ts` (built-in permission grants, see below), `functions/` (implementation, DB access, modal/
button handlers). Look at `src/plugins/tags/` for the minimal shape.

### Command dispatch & authorization (`src/bot.ts`)
For every interaction, in order: resolve the command from `ctx.commands`/`ctx.contextMenuCommands` → guild-only
check → plugin-enabled check (`pluginEnabled`, `plugins.<name>.enabled !== false`) → `manageServer` check (Discord
Manage Guild) → "config required" check for plugins in `pluginsRequiringConfig` (no stored config yet) →
`command.permission` check via `hasPluginPermission` → `command.discordPermissions` bitfield check → execute,
then fire-and-forget `trackCommandUsage`. Buttons/selects/modals are dispatched by matching `customId` prefixes
defined per-plugin (e.g. `ROLE_BUTTON_PREFIX`, `SUGGEST_PREFIX`) directly in the big interaction handler — there
is no generic component registry beyond `interactionStore.buttonHandlers`.

Inside a plugin's `execute`, prefer `requirePluginPermission(ctx, pluginName, "can_x")`
(`src/core/pluginCommand.ts`) over reimplementing the enabled/permission checks — it also resolves and returns
the merged `pluginConfig` for the invoking member/channel.

### Permission model
Two independent layers (see `docs/permissions.md`):
1. **Discord permissions** — `command.discordPermissions`, `manageServer`, or ad-hoc checks in command code.
2. **Dreamliner levels + `can_*` flags** — a guild's `levels` map assigns a numeric level to role/user snowflakes;
   a member's level is the max match. Plugin config carries boolean `can_*` flags, granted either directly under
   `plugins.<name>.config` or via `overrides` (`level`/`channel`/`category`/`user`/`role` criteria, later matches
   merge over earlier ones). `src/core/permissions.ts` (`hasPluginPermission`, `resolvePluginConfig`) implements
   the matching; `src/core/guildHelpers.ts` (`getPluginDefaultOverrides`) supplies each plugin's built-in defaults
   (e.g. `defaultOverrides.ts` in the plugin dir), merged in unless the guild sets `replaceDefaultOverrides: true`.

### Config system (`src/config/`)
- `config/default.server.yaml` is the base template; `config/schemas/guild.ts` composes per-plugin zod schemas
  (`config/schemas/*.ts`, one file per plugin section) into the full `GuildConfig` type.
- `config/validator.ts` handles parsing, deep-merge with defaults, and repair-on-load (invalid/obsolete keys are
  stripped rather than rejecting the whole config).
- `config/manager.ts` (`ConfigManager`, singleton `configManager`) is the only way plugins read/write guild
  config: `getGuildConfig`/`getEffectiveConfig` (cached, falls back to defaults if a guild has no stored/valid
  config), `saveGuildConfig` (full YAML upload), and granular patch helpers (`patchPluginConfig`,
  `setPluginEnabled`, `patchLevels`, `setPermissionGrant`) used by `/permissions`, `/plugin toggle`, etc. Two YAML
  copies are stored per guild: the full merged snapshot (`configYaml`) and just the user's overrides
  (`userConfigYaml`), so `/config update` can re-merge overrides onto new defaults without clobbering
  customization.
- `npm run schema:export` (also run in `prebuild`) writes `schema/guild-config.schema.json` from the zod schemas
  for the external website's config editor to consume — keep plugin config schemas in sync if you change them.

### Database (`src/db/`, `drizzle/`)
Single large `src/db/schema.ts` (drizzle-orm, sqlite dialect) backs everything: guild configs, infractions,
stats, dream_commands, economy, passport, reviews/suggestions, dashboard bridge state, etc. Schema changes go
through `npm run db:generate` (writes a new file in `drizzle/migrations/`) then `npm run db:migrate` (also run
automatically on boot via `runMigrations()` in `src/index.ts`). `src/db/client.ts` exposes `getDb()`.

### Dreamcode (`src/dreamcode/`, `src/plugins/dream_commands/`)
A small guild-scoped scripting language for user-authored `/slash` commands (max 10/guild), stored in the
`dream_commands` table. Pipeline: `lexer.ts` → `parser.ts` → `validate.ts` (also used at create-time) →
`interpret.ts`, executing against `actions.ts` (the allowed action catalog — no eval/filesystem/network). Discord
hosting glue lives in `src/plugins/dream_commands/functions/host.ts`. `docs/dreamcode/` is the language reference;
`npm run dreamcode:export` regenerates the machine-readable `actions.catalog.json` the website editor consumes
from `src/dreamcode/actions.ts` — keep them in sync when adding/changing actions.

### Bridge (`src/bridge/`)
`dashboardBridge.ts` starts a plain `node:http` server (port from `DASHBOARD_BRIDGE_PORT`, default 4080) guarded
by a `Bearer <DASHBOARD_BRIDGE_SECRET>` check, only started if `isDashboardBridgeEnabled()`. Each `web*.ts` /
other bridge file exposes one area of bot state to the external website (automod, economy, logs, passport,
stats, tags, etc.) — these are the only integration points between the bot process and the dashboard site;
there's no shared code with the frontend. `superuser.ts` gates extra dashboard access by Discord user ID.

### Cross-cutting helpers worth knowing about (`src/core/`)
- `responses.ts` — `resultReply`/`slashResultOptions`/`guildResultOptions` build the bot's consistent embed
  replies (title emoji from `guildConfig.emojis`, author always "Dreamliner").
- `templates.ts` — `{user}`/`{username}`/`{guild}`/... placeholder rendering used by tags, welcome messages, etc.
- `docsUrl.ts` — resolves links back to the external site/docs, respecting `DREAMLINER_ENV`.
- `scheduler.ts` — in-process scheduling for reminders/posts (`setSchedulerClient` wires it to the live client at
  boot).
