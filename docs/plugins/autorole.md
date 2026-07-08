# Autorole plugin

Automatically assigns roles when members join your server. Each role can have its own delay before it is applied.

## Configuration

```yaml
plugins:
  autorole:
    enabled: true
    config:
      roles:
        - role: "1234567890123456789"
          delay_ms: 0
        - role: "9876543210987654321"
          delay: "30s"
```

| Field | Description |
|-------|-------------|
| `role` | Role snowflake ID to assign |
| `delay_ms` | Wait time in milliseconds before this role is assigned (`0` = immediate) |
| `delay` | Optional duration string (`30s`, `5m`, `1h`, `1d`, `1w`) for this role; overrides `delay_ms` when valid |

You can also use a plain role ID string for immediate assignment:

```yaml
roles:
  - "1111111111111111111"
  - role: "2222222222222222222"
    delay: "1m"
```

Set `enabled: false` on the plugin section to turn autorole off without removing your role list.

## Requirements

- The bot needs the **Manage Roles** permission.
- The bot's highest role must be **above** every autorole role.
- Managed roles (integrations, bot roles, etc.) cannot be assigned and are skipped.
- Bots joining the server are ignored.

## Examples

Welcome role immediately, verified role after 30 seconds:

```yaml
plugins:
  autorole:
    config:
      roles:
        - role: "1111111111111111111"
          delay_ms: 0
        - role: "2222222222222222222"
          delay: "30s"
```
