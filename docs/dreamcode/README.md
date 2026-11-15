# Custom commands

Custom commands are guild-scoped **slash** commands (`/name`, max 10 per server) that reply with a message or an embed. They are built on the website's dashboard, on the Commands page (list plus an in-place editor with a live preview, deep-linkable as `?section=commands&command=<name>` or `&command=new`): no scripting involved.

## Building one

Open a server's dashboard, go to Commands, and click Add command (or pick one of the starters on an empty list). Fill in:

- **Name** - the slash command: lowercase letters, numbers, and underscores only, 1-32 characters. It can't be a built-in Dreamliner command name, and it can't be changed after the command is made (duplicate it instead).
- **Description** - shown under the command in Discord, 1-100 characters.
- **Live in Discord** - off keeps the command saved but takes it out of Discord's command list (`enabled` on the row).
- **Only the person who ran it sees the reply** - an ephemeral reply.
- **Reply** - one of:
  - **Text message**: up to 2000 characters.
  - **Embed**: title (+ link), description, colour (or none), author (name, link, icon), thumbnail, image, footer text, timestamp. Needs a title, description, or author name.
  - **Random reply**: up to 10 text messages; one is picked at random each time.

The dashboard list also shows each command's uses (total, last 7 and 30 days, last used day) and who made it.

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
- Usage numbers for the dashboard: `src/plugins/dream_commands/functions/usage.ts` (reads the Stats `command_usage_daily` / `command_usage_totals` tables by command name)
- Bridge API for the website: `src/bridge/dreamCommands.ts` (`GET /bridge/guilds/:id/commands` also returns per-command `usage` and `creator`, overall `usage` with a 30-day `daily` series, and `reservedNames`)

## Design rules

1. Guild-contained only.
2. Always exactly one reply: a message or an embed, never both, never a sequence of actions.
3. Validated on save (`validateProgram`), before the row is written.
4. Website builds the same JSON program the bot stores and runs.
