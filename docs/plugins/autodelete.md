# Autodelete plugin

Automatically delete messages in a channel after a configured delay.

## Configuration

```yaml
plugins:
  autodelete:
    enabled: true
    config:
      default_delay_seconds: 60
    overrides:
      - level: ">=50"
        config:
          can_set: true
          can_clear: true
```

| Field | Description |
|-------|-------------|
| `default_delay_seconds` | Default delete delay when not specified on `/autodelete set` |

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/autodelete set` | `can_set` | Enable autodelete on a channel |
| `/autodelete clear` | `can_clear` | Disable autodelete on a channel |

## Requirements

- The bot needs **Manage Messages** in the target channel.
- Delay can be set from 1 second up to 604800 seconds (7 days).
