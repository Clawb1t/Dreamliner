# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Dreamliner is a Discord moderation/ops bot (discord.js v14 + TypeScript, ESM, Node >= 20). Per-guild config is
authored as YAML, deep-merged with defaults and stored as JSON in SQLite (drizzle-orm + better-sqlite3). A separate website
(dreamliner.site, not in this repo) provides a config editor and dashboard; it talks to the bot only through a
small authenticated HTTP bridge in `src/bridge/`. `dashboard/` is empty local scaffolding (only an ignored build
output); the actual dashboard frontend lives in a different project.

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
```

Run a single test file directly, e.g.:
```bash
npx tsx --test src/core/userRegex.test.ts
```

There is no lint script/config in this repo — `typecheck` is the correctness gate.

`.env` needs at least `DISCORD_TOKEN`; see `.env.example` for the rest (dashboard bridge, Dreamliner One SKU,
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
- `name`, `configSchema` (zod), `dependencies`
- `slashCommands` / `contextMenuCommands` — each carries its own `plugin`, optional `permission` (a `can_*`
  flag name), `manageServer`, `discordPermissions`, and `execute(ctx)`
- `events` — discord.js event handlers registered per-plugin
- `onLoad(ctx)` — one-time setup when the bot boots

All plugins are registered in `src/plugins/availablePlugins.ts`; add a new plugin there. `src/core/pluginLoader.ts`
flattens every plugin's commands/events into the shared `BotContext` (`commands`, `contextMenuCommands`,
`interactionStore`) and wraps each event handler so a thrown error is logged, not fatal.

A typical plugin directory: `index.ts` (definePlugin + export), `commands.ts` (SlashCommandDefinition[]),
`functions/` (implementation, DB access, modal/button handlers). Look at `src/plugins/reminders/` for the
minimal shape.

### Command dispatch & authorization (`src/bot.ts`)
For every interaction, in order: resolve the command from `ctx.commands`/`ctx.contextMenuCommands` → guild-only
check → plugin-enabled check (`pluginEnabled`, `plugins.<name>.enabled !== false`) → `manageServer` check (Discord
Manage Guild) → "config required" check for plugins in `pluginsRequiringConfig` (no stored config yet) →
`command.permission` check via `hasPermission` (`src/core/permissionRoles.ts`) → `command.discordPermissions` bitfield check → execute,
then fire-and-forget `trackCommandUsage`. Buttons/selects/modals are dispatched by matching `customId` prefixes
defined per-plugin (e.g. `ROLE_BUTTON_PREFIX`, `SUGGEST_PREFIX`) directly in the big interaction handler — there
is no generic component registry beyond `interactionStore.buttonHandlers`.

Inside a plugin's `execute`, prefer `requirePluginPermission(ctx, pluginName, "can_x")`
(`src/core/pluginCommand.ts`) over reimplementing the enabled/permission checks — it also resolves and returns
the merged `pluginConfig` for the invoking member/channel.

### Permission model
Two independent layers (see `docs/permissions.md`):
1. **Discord permissions** — `command.discordPermissions`, `manageServer`, or ad-hoc checks in command code.
2. **Dreamliner Roles + `can_*` grants** — named per-guild permission groups (`guild_permission_roles` table), each
   assigned to Discord roles and/or members and granting a flat set of `can_*` keys. Every member belongs to the
   built-in Member role; Moderator and Admin are the other built-ins, with default grants in
   `src/config/permissionRoleDefaults.ts`. `src/core/permissionRoles.ts` implements it: `hasPermission` ORs the
   grants across a member's roles, and `hasAdminBypass` (guild owner, Administrator or Manage Server, unless the
   guild sets `admin_bypass: false`) allows everything.

### Config system (`src/config/`)
- `config/default.server.yaml` is the base template; `config/schemas/guild.ts` composes per-plugin zod schemas
  (`config/schemas/*.ts`, one file per plugin section) into the full `GuildConfig` type.
- `config/validator.ts` handles parsing, deep-merge with defaults, and repair-on-load (invalid/obsolete keys are
  stripped rather than rejecting the whole config).
- `config/manager.ts` (`ConfigManager`, singleton `configManager`) is the only way plugins read/write guild
  config: `getGuildConfig`/`getEffectiveConfig` (cached, falls back to defaults if a guild has no stored/valid
  config), `saveGuildConfig` (full replace from the user's YAML — called by the dashboard bridge, and once by
  `bot.ts`'s `GuildCreate` handler to auto-provision a default config so a brand-new guild's commands work
  immediately), and granular patch helpers (`patchPluginConfig`, `patchTopLevelConfig`, `setPluginEnabled`). Each
  guild row stores the full merged config (`configJson`), just the user's overrides (`userConfigJson`) and a
  snapshot of the defaults (`defaultsSnapshotJson`), so future default changes can be re-merged onto overrides
  without clobbering customization. Config is edited on the dashboard; `/config` links there.
- `npm run schema:export` (also run in `prebuild`) writes `schema/guild-config.schema.json` from the zod schemas
  for the external website's config editor to consume — keep plugin config schemas in sync if you change them.

### Database (`src/db/`, `drizzle/`)
Single large `src/db/schema.ts` (drizzle-orm, sqlite dialect) backs everything: guild configs, infractions,
stats, dream_commands, economy, passport, reviews/suggestions, dashboard bridge state, etc. Schema changes go
through `npm run db:generate` (writes a new file in `drizzle/migrations/`) then `npm run db:migrate` (also run
automatically on boot via `runMigrations()` in `src/index.ts`). `src/db/client.ts` exposes `getDb()`.

### Custom commands (`src/plugins/dream_commands/`)
User-built guild `/slash` commands, made on the website dashboard like a shortcut (no scripting, no in-Discord
authoring): typed options, access rules, cooldowns, and an ordered list of steps (actions such as reply or give a
role, and blocks such as If, Repeat, Buttons, Form). Stored in the `dream_commands` table. `engine/` is the builder
runtime (`engine/types.ts` holds the program shape and `LIMITS`: 25 commands per server, 100 with Dreamliner One);
`functions/run.ts` runs commands and their button, menu and form follow-ups. `docs/dreamcode/README.md` is the
reference doc.

### Bridge (`src/bridge/`)
`dashboardBridge.ts` starts a plain `node:http` server (port from `DASHBOARD_BRIDGE_PORT`, default 4080) guarded
by a `Bearer <DASHBOARD_BRIDGE_SECRET>` check, only started if `isDashboardBridgeEnabled()`. Each `web*.ts` /
other bridge file exposes one area of bot state to the external website (automod, economy, logs, passport,
stats, quizzes, etc.) — these are the only integration points between the bot process and the dashboard site;
there's no shared code with the frontend. `superuser.ts` gates extra dashboard access by Discord user ID.
`webAi.ts` exposes the dashboard's "Autopilot" features (OpenAI-backed, see `src/core/ai/`) — one-shot
copywriting plus the conversational setup wizards, one per plugin in `src/core/ai/wizards/`, registered through
`src/core/ai/wizards.ts`. Free-tier guilds get `AI_FREE_USES_LIMIT` uses total (`src/core/ai/usage.ts`),
shared across every Autopilot feature, enforced by `consumeAiGate` in `src/core/ai/gate.ts`, before Dreamliner One
is required. Internal module/identifier names still say "ai" (e.g. `core/ai/`, `consumeAiGate`) — only the
user-facing brand is "Autopilot".

### Cross-cutting helpers worth knowing about (`src/core/`)
- `responses.ts` — `resultReply`/`slashResultOptions`/`guildResultOptions` build the bot's consistent embed
  replies (title emoji from `guildConfig.emojis`, author always "Dreamliner").
- `templates.ts` — `{user}`/`{username}`/`{guild}`/... placeholder rendering used by welcome messages, autoreplies, etc.
- `docsUrl.ts` — resolves links back to the external site/docs, respecting `DREAMLINER_ENV`.
- `scheduler.ts` — in-process scheduling for reminders/posts (`setSchedulerClient` wires it to the live client at
  boot).
