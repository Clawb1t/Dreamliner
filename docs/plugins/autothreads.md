# Autothreads plugin

Automatically start a thread on a matching message and post a customizable message inside it. Dashboard setup mirrors Autoreplies: the same match/limit controls, plus persist-level payload options (embeds, webhooks, link buttons, mention flags).

## Configuration

```yaml
plugins:
  autothreads:
    enabled: true
    config:
      rules:
        - id: 1
          channel_id: "*"
          thread_name: "{user_display}"
          auto_archive_minutes: 1440
          response: "Let's keep this discussion here."
          trigger: contains
          match: "help"
          cooldown_seconds: 30
    overrides:
      - level: ">=50"
        config:
          can_add: true
          can_remove: true
          can_list: true
```

| Field | Description |
|-------|-------------|
| `rules` | List of auto-thread rules |
| `id` | Unique rule ID |
| `channel_id` | Channel ID, or empty/`*` for all channels |
| `thread_name` | Thread title (max 100). Supports `{user}`, `{user_display}`, `{guild}`, `{channel}` |
| `auto_archive_minutes` | Idle archive: `60`, `1440`, `4320`, or `10080` |
| `thread_slowmode_seconds` | Optional slowmode inside the new thread |
| `response` | Optional text posted in the thread (max 2000). Supports placeholders. Can be empty if an embed or buttons are set |
| `trigger` | `every_message`, `contains`, `starts_with`, `exact`, or `regex` |
| `match` | Text/regex to match (required unless `trigger` is `every_message`). Regex is case-insensitive. Whole word: `\bthread\b` |
| `every_n` | Only create a thread on every Nth matching message |
| `cooldown_seconds` | Minimum seconds between threads for this rule |
| `attachments_only` | Only messages with attachments |
| `links_only` | Only messages containing a link |
| `embed` | Same embed options as persist (title, description, color, images, footer) |
| `buttons` | Optional link buttons (max 5) |
| `webhook` | Send the thread message with a custom name/avatar (needs Manage Webhooks) |
| `webhook_name` / `webhook_avatar_url` | Custom webhook identity |
| `silent` | Suppress notifications |
| `suppress_embeds` | Don’t unfurl links in the text |
| `mention_users` / `mention_roles` / `mention_everyone` | Allowed mention types |

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/autothread add` | `can_add` | Create a rule (`message` required; optional `thread_name`, `channel`, `trigger`, `match`, `auto_archive`) |
| `/autothread remove` | `can_remove` | Remove a rule by ID |
| `/autothread list` | `can_list` | List all rules with IDs |

Use the dashboard editor for embeds, webhooks, buttons, mention flags, and cadence filters.

## Behaviour

- Listens in text and announcement channels. Messages already in a thread, bot/webhook messages, and messages that already have a thread are ignored.
- Discord allows one thread per message, so the first matching rule that succeeds wins.
- Webhook posts use a parent-channel webhook with `threadId`. If a webhook cannot be created, Dreamliner falls back to sending as the bot.

## Requirements

- The bot needs **Create Public Threads**, **Send Messages**, and **Send Messages in Threads** in the target channel(s).
- Webhook messages need **Manage Webhooks**. If a webhook cannot be created, Dreamliner falls back to sending as the bot.
- Bot and webhook messages are ignored and will not trigger rules.
