# Custom commands

Custom commands are guild-scoped **slash** commands (`/name`, max 10 per server) that reply with a message or an embed. They are built on the website's dashboard, in a modal: no scripting involved.

## Building one

Open a server's dashboard, go to Commands, and click Add Command. Fill in:

- **Name** — the slash command, lowercase letters, numbers, and underscores only.
- **Description** — shown under the command in Discord.
- **Response type** — Text message or Discord embed.
- **Content** — the reply itself. Turn on Random reply to pick one of several messages at random each time the command runs (text replies only).
- **Ephemeral reply** — only the person who ran the command sees the reply.

## Variables

These tokens work in text content and in every embed text field:

| Token | Resolves to |
|-------|-------------|
| `{user}` | The invoker's username |
| `{mention}` | A mention of the invoker |
| `{server}` | The server's name |
| `{channel}` | The channel the command was run in |

## Architecture (bot)

- Program shape + validation: `src/plugins/dream_commands/functions/program.ts`
- Reply rendering: `src/plugins/dream_commands/functions/run.ts`
- Storage: SQLite `dream_commands` table, `program` column holds the JSON program
- Bridge API for the website: `src/bridge/dreamCommands.ts`

## Design rules

1. Guild-contained only.
2. Always exactly one reply: a message or an embed, never both, never a sequence of actions.
3. Validated on save (`validateProgram`), before the row is written.
4. Website builds the same JSON program the bot stores and runs.
