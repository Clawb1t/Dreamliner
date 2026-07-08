# Dreamliner

Dreamliner is a Discord moderation and server-management bot inspired by [Zeppelin](https://github.com/ZeppelinBot/Zeppelin). Configuration is done via YAML files that you download, edit, and upload - no dashboard required.

## Features

- File-based YAML configuration with database persistence
- Slash commands only
- Minimal output (plain text or Components v2 without colored containers)
- Configurable success/error/neutral emojis per server
- Utility plugin with search, info, moderation helpers, voice tools, and more

## Quick start

1. Copy `.env.example` to `.env` and fill in your Discord credentials.
2. Install dependencies:

```bash
pnpm install
```

3. Run database migrations:

```bash
pnpm db:migrate
```

4. Register slash commands:

```bash
pnpm register-commands
```

5. Start the bot:

```bash
pnpm dev
```

6. In your server, run `/config template`, edit the YAML file, then `/config upload`.

## Documentation

- [Getting started](docs/getting-started.md)
- [Configuration](docs/configuration.md)
- [Permissions setup](docs/permissions.md)
- [Utility plugin](docs/plugins/utility.md)

## Environment variables

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token from the Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Application client ID |
| `DATABASE_URL` | SQLite path (`file:./data/dreamliner.db`) or PostgreSQL URL |
| `DOCS_BASE_URL` | Base URL for documentation links in `/help` and `/about` |

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | Run in development with hot reload |
| `pnpm build` | Compile TypeScript |
| `pnpm start` | Run compiled bot |
| `pnpm register-commands` | Register slash commands with Discord |
| `pnpm db:migrate` | Apply database migrations |
| `pnpm typecheck` | Type-check without emitting |

## License

MIT
