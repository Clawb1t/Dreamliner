# Role buttons plugin

Toggle roles with button components on a message. Create a new panel or add buttons to an existing message.

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

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/rolebutton create` | `can_create` | Add a role toggle button to a new or existing message |
| `/rolebutton delete` | `can_delete` | Remove role buttons from a message |

## Requirements

- The bot needs **Manage Roles** and **Send Messages** in the target channel.
- The bot's highest role must be above toggled roles.
- Button interactions are handled automatically while the bot is online.
