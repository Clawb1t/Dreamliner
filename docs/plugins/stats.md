# Stats plugin

View activity statistics for the server, a user, or a channel.

## Configuration

```yaml
plugins:
  stats:
    enabled: true
    overrides:
      - level: ">=50"
        config:
          can_server: true
          can_user: true
          can_channel: true
```

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/stats server` | `can_server` | Server activity statistics |
| `/stats user` | `can_user` | Activity stats for a user |
| `/stats channel` | `can_channel` | Activity stats for a channel |

## Requirements

- Stats are aggregated from message activity tracked by Dreamliner.
- Historical data depends on how long the bot has been logging activity in the server.
