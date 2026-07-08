# Self grantable roles plugin

Let members assign themselves roles from a button or select menu panel posted in a channel.

## Configuration

```yaml
plugins:
  self_grantable_roles:
    enabled: true
    config:
      max_roles_per_panel: 10
    overrides:
      - level: ">=50"
        config:
          can_configure: true
```

| Field | Description |
|-------|-------------|
| `max_roles_per_panel` | Maximum roles on a single panel (1–25) |

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/selfrole configure` | `can_configure` | Post a self-role panel in a channel |

## Requirements

- The bot needs **Manage Roles** and **Send Messages** in the target channel.
- The bot's highest role must be above every self-assignable role.
- Panel style can be `buttons` or `select`.
