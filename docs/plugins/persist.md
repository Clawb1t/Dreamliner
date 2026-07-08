# Persist plugin

Keep a pinned-style message at the bottom of a channel. When the persisted message is deleted, Dreamliner reposts the saved content automatically.

## Configuration

```yaml
plugins:
  persist:
    enabled: true
    overrides:
      - level: ">=50"
        config:
          can_add: true
          can_remove: true
          can_list: true
```

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/persist add` | `can_add` | Persist a message by ID |
| `/persist remove` | `can_remove` | Remove persistence from a channel |
| `/persist list` | `can_list` | List persisted messages |

## Requirements

- The bot needs **Send Messages** in the target channel.
- Only one persisted message is tracked per channel.
- When the tracked message is deleted, the bot reposts the stored content and updates the tracked message ID.
