# Autoreactions plugin

Automatically react to new messages with a specific emoji. Rules can apply to one channel or all channels, and optionally require a regex match.

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
          regex: "^hello"
    overrides:
      - level: ">=50"
        config:
          can_add: true
          can_remove: true
          can_list: true
```

| Field | Description |
|-------|-------------|
| `rules` | List of rules with `id`, `channel_id` (`*` for all channels), `emoji`, and optional `regex` |

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/autoreaction add` | `can_add` | Add a rule (omit `channel` for all channels, optional `regex`) |
| `/autoreaction remove` | `can_remove` | Remove a rule by ID |
| `/autoreaction list` | `can_list` | List all rules with IDs |

## Requirements

- The bot needs **Add Reactions** in the target channel(s).
- Bot messages are not auto-reacted.
