# Reminders plugin

Set personal reminders that Dreamliner delivers in the channel where they were created.

## Configuration

```yaml
plugins:
  reminders:
    enabled: true
    overrides:
      - level: ">=50"
        config:
          can_create: true
          can_list: true
          can_cancel: true
```

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/remind` | `can_create` | Set a reminder with a message and delay in minutes |
| `/reminders list` | `can_list` | List your active reminders |
| `/reminders cancel` | `can_cancel` | Cancel a reminder by ID |

## Requirements

- Reminders are delivered as a mention in the original channel.
- Reminders are checked periodically while the bot is running.
- Each user can only cancel their own reminders.
