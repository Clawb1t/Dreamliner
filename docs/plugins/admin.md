# Admin plugin

Server-wide lockdown controls. Lockdown denies **Send Messages** in all text channels for a target role (defaults to `@everyone`).

## Configuration

```yaml
plugins:
  admin:
    enabled: true
    config:
      lockdown_role_id: "1234567890123456789"
    overrides:
      - level: ">=50"
        config:
          can_lockdown: true
          can_unlock: true
```

| Field | Description |
|-------|-------------|
| `lockdown_role_id` | Role to lock out of text channels (defaults to `@everyone`) |

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/lockdown` | `can_lockdown` | Deny Send Messages in all text channels |
| `/unlock` | `can_unlock` | Restore Send Messages in text channels |

## Requirements

- The bot needs **Manage Channels** to edit channel permission overwrites.
- Lockdown and unlock apply to every text channel in the server.
