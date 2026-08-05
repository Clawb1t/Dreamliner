# Autoreplies plugin

Automatically reply when messages match a trigger. Setup mirrors autoreactions: pick the reply text in the slash command, then finish the rule in a modal.

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
| `channel_id` | Channel ID, or `*` for all channels |
| `response` | Message the bot sends (max 2000) |
| `trigger` | `every_message`, `contains`, `starts_with`, `exact`, or `regex` |
| `match` | Text/regex to match (required unless `trigger` is `every_message`) |
| `every_n` | Only reply on every Nth matching message |
| `cooldown_seconds` | Minimum seconds between replies for this rule |
| `attachments_only` | Only messages with attachments |
| `links_only` | Only messages containing a link |
| `reply_to_message` | When `true` (default), reply to the trigger message |

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
- Bot messages are ignored and will not trigger rules.
