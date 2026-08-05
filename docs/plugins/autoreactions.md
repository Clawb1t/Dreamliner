# Autoreactions plugin

Automatically react to new messages with a specific emoji. Rules can apply to one channel or all channels, with flexible triggers and optional cadence controls.

## Configuration

```yaml
plugins:
  autoreactions:
    enabled: true
    config:
      rules:
        - id: 1
          channel_id: "*"
          emoji: "👍"
          trigger: every_message
        - id: 2
          channel_id: "123456789012345678"
          emoji: "🔥"
          trigger: contains
          match: "pog"
          every_n: 5
          cooldown_seconds: 30
        - id: 3
          channel_id: "*"
          emoji: "📎"
          trigger: every_message
          attachments_only: true
    overrides:
      - level: ">=50"
        config:
          can_add: true
          can_remove: true
          can_list: true
```

| Field | Description |
|-------|-------------|
| `rules` | List of rules (see below) |
| `id` | Unique rule ID |
| `channel_id` | Channel ID, or `*` for all channels |
| `emoji` | Emoji to react with |
| `trigger` | `every_message`, `contains`, `starts_with`, `exact`, or `regex` (default: `every_message`) |
| `match` | Text/regex to match (required unless `trigger` is `every_message`) |
| `regex` | Legacy: treated as `trigger: regex` + `match` |
| `every_n` | Only react on every Nth matching message (optional, ≥2) |
| `cooldown_seconds` | Minimum seconds between reactions for this rule (optional) |
| `attachments_only` | Only react when the message has attachments |
| `links_only` | Only react when the message contains a link |

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/autoreaction add` | `can_add` | Requires `emoji`, then opens a modal for trigger/channel/extras |
| `/autoreaction remove` | `can_remove` | Remove a rule by ID |
| `/autoreaction list` | `can_list` | List all rules with IDs |

### Add form

1. Run `/autoreaction add emoji:…` (unicode or custom emoji)
2. A Discord modal opens (see [modal components](https://docs.discord.com/developers/components/using-modal-components)) with:
   - **When should it react?** — dropdown (every message, contains, starts with, exact, regex)
   - **Match text** — optional; required unless you chose every message
   - **Channel** — optional channel picker (empty = all channels)
   - **Extras** — multi-select for cadence/filters (every Nth match, cooldowns, attachments/links only)

## Requirements

- The bot needs **Add Reactions** in the target channel(s).
- Bot messages are not auto-reacted.
