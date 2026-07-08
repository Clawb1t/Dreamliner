# Locate user plugin

Find which voice channel a member is currently in.

## Configuration

```yaml
plugins:
  locate_user:
    enabled: true
    overrides:
      - level: ">=50"
        config:
          can_locate: true
```

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/locate` | `can_locate` | Show a member's current voice channel |

## Requirements

- Returns a channel mention when the member is in voice, or a not-in-voice message otherwise.
- Works for any member the bot can see in the server.
