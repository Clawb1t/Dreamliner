# Reminders plugin

Set personal reminders that Dreamliner delivers in the channel where they were created.

## Configuration

```yaml
plugins:
  reminders:
    enabled: true
```

Grant `can_create`, `can_list`, and `can_cancel` to a Dreamliner Role on the dashboard's **Roles** page (or
`/permissions role grant`) — see [permissions.md](../permissions.md).

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
