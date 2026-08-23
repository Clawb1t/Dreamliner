# Role buttons plugin (legacy)

> **Superseded.** Button roles are now configured through the [Role Panels](./role_panels.md)
> dashboard feature — `/rolebutton` has been removed. Panels created with the old command before
> this change keep working automatically; there is just no way to create new ones via command
> anymore. To manage button roles going forward, use Role Panels in the dashboard.

Toggle roles with button components on a message.

## Configuration

```yaml
plugins:
  role_buttons:
    enabled: true
    overrides:
      - level: ">=50"
        config:
          can_create: true
          can_delete: true
```

The `can_create`/`can_delete` flags no longer gate anything (there's no command left to gate) —
they're kept only so old configs stay valid.

## Requirements

- The bot needs **Manage Roles** and **Send Messages** in the target channel.
- The bot's highest role must be above toggled roles.
- Button interactions are handled automatically while the bot is online.
