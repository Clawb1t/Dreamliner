# Pingable roles plugin

Toggle whether a role can be mentioned by regular members. Useful for announcement or event roles.

## Configuration

```yaml
plugins:
  pingable_roles:
    enabled: true
    overrides:
      - level: ">=50"
        config:
          can_enable: true
          can_disable: true
```

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/pingrole enable` | `can_enable` | Allow a role to be mentioned |
| `/pingrole disable` | `can_disable` | Prevent a role from being mentioned |

## Requirements

- The bot needs **Manage Roles**.
- Only roles below the bot's highest role can be modified.
