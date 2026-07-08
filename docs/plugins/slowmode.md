# Slowmode plugin

Set or clear channel slowmode from Discord slash commands.

## Configuration

```yaml
plugins:
  slowmode:
    enabled: true
    config:
      default_seconds: 5
    overrides:
      - level: ">=50"
        config:
          can_set: true
          can_clear: true
```

| Field | Description |
|-------|-------------|
| `default_seconds` | Default slowmode delay when `/slowmode set` omits a value |

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/slowmode set` | `can_set` | Set slowmode on a channel (0–21600 seconds) |
| `/slowmode clear` | `can_clear` | Remove slowmode from a channel |

## Requirements

- The bot needs **Manage Channels** in the target channel.
- Slowmode values must be between 0 and 21600 seconds (6 hours).
