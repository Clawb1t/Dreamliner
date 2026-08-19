# Autoreplies plugin

Automatically reply when messages match a trigger. Dashboard setup mirrors persist for the reply payload (embeds, webhooks, link buttons, mention flags) plus the same match/limit controls as autoreactions.

## Configuration

```yaml
plugins:
  autoreplies:
    enabled: true
    config:
      rules:
        - id: 1
          channel_id: "*"
          response: "Welcome! Check #rules"
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
| `rules` | List of reply rules |
| `id` | Unique rule ID |
| `channel_id` | Channel ID, or empty/`*` for all channels |
| `response` | Optional text above the embed (max 2000). Supports `{user}`, `{guild}`, `{channel}` |
| `trigger` | `every_message`, `contains`, `starts_with`, `exact`, or `regex` |
| `match` | Text/regex to match (required unless `trigger` is `every_message`). Regex is case-insensitive. Whole word: `\bhelp\b` |
| `every_n` | Only reply on every Nth matching message |
| `cooldown_seconds` | Minimum seconds between replies for this rule |
| `attachments_only` | Only messages with attachments |
| `links_only` | Only messages containing a link |
| `reply_to_message` | When `true` (default), reply to the trigger message. Ignored when `webhook` is on |
| `embed` | Same embed options as persist (title, description, color, images, footer) |
| `buttons` | Optional link buttons (max 5) |
| `webhook` | Send with a custom name/avatar (needs Manage Webhooks) |
| `webhook_name` / `webhook_avatar_url` | Custom webhook identity |
| `silent` | Suppress notifications |
| `suppress_embeds` | Don’t unfurl links in the text |
| `mention_users` / `mention_roles` / `mention_everyone` | Allowed mention types |

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/autoreply add` | `can_add` | Requires `message`, then opens a modal for trigger/send mode/channel/extras |
| `/autoreply remove` | `can_remove` | Remove a rule by ID |
| `/autoreply list` | `can_list` | List all rules with IDs |

### Add form

1. Run `/autoreply add message:…` with the reply text
2. Modal asks:
   - **When should it reply?** (dropdown)
   - **Match text**
   - **How should it send?** (radio: reply to the message, or send after the trigger)
   - **Channel** (optional)
   - **Extras** (cadence/filters)

## Requirements

- The bot needs **Send Messages** (and **Read Message History** if using reply) in the target channel(s).
- Webhook replies need **Manage Webhooks**. If a webhook cannot be created, Dreamliner falls back to sending as the bot.
- Bot and webhook messages are ignored and will not trigger rules.
