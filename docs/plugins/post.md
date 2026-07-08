# Post plugin

Schedule messages to be sent to a channel after a delay.

## Configuration

```yaml
plugins:
  post:
    enabled: true
    overrides:
      - level: ">=50"
        config:
          can_create: true
          can_list: true
          can_delete: true
```

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/post create` | `can_create` | Schedule a message with a delay in minutes |
| `/post list` | `can_list` | List pending scheduled posts |
| `/post delete` | `can_delete` | Cancel a scheduled post by ID |

## Requirements

- The bot needs **Send Messages** in the target channel.
- Scheduled posts are checked periodically while the bot is running.
- Delay is specified in minutes (minimum 1).
