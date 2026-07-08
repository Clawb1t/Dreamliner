# Welcome message plugin

Send a configurable welcome message when members join your server.

## Configuration

```yaml
plugins:
  welcome_message:
    enabled: true
    config:
      channel_id: "1234567890123456789"
      message: "Welcome {user} to **{guild}**!"
    overrides:
      - level: ">=50"
        config:
          can_set: true
          can_test: true
          can_disable: true
```

| Field | Description |
|-------|-------------|
| `channel_id` | Text channel for welcome messages |
| `message` | Template with `{user}` and `{guild}` placeholders |

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/welcome set` | `can_set` | Set the welcome channel and message |
| `/welcome test` | `can_test` | Send a test welcome message |
| `/welcome disable` | `can_disable` | Turn off welcome messages |

## Requirements

- The bot needs **Send Messages** in the welcome channel.
- Bot accounts joining the server are ignored.
