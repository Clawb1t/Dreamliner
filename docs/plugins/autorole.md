# Autorole plugin

Automatically assigns roles when members join your server. Humans and bots use separate lists, and each role can have its own delay before it is applied.

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
      bot_roles:
        - role: "5555555555555555555"
          delay_ms: 0
```

| Field | Description |
|-------|-------------|
| `roles` | Roles assigned when a **human** joins |
| `bot_roles` | Roles assigned when a **bot** joins |
| `role` | Role snowflake ID to assign |
| `delay_ms` | Wait time in milliseconds before this role is assigned (`0` = immediate) |
| `delay` | Optional duration string (`30s`, `5m`, `1h`, `1d`, `1w`) for this role; overrides `delay_ms` when valid |

You can also use a plain role ID string for immediate assignment:

```yaml
roles:
  - "1111111111111111111"
  - role: "2222222222222222222"
    delay: "1m"
bot_roles:
  - "3333333333333333333"
```

Set `enabled: false` on the plugin section to turn autorole off without removing your role lists.

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/autorole add` | `can_add` | Open a form to pick humans/bots, a role, and optional delay |
| `/autorole remove` | `can_remove` | Remove a role from the humans or bots list (`for`) |
| `/autorole list` | `can_list` | List configured autoroles (`for`: both, humans, or bots) |

Changes from commands are saved to your server config (same YAML section as manual edits). Use `/config download` to export the updated config.

Default permission grants (level **50+**):

```yaml
overrides:
  - level: ">=50"
    config:
      can_add: true
      can_remove: true
      can_list: true
```

## Requirements

- The bot needs the **Manage Roles** permission.
- The bot's highest role must be **above** every autorole role.
- Managed roles (integrations, bot roles, etc.) cannot be assigned and are skipped.

## Examples

Welcome role for humans immediately, verified role after 30 seconds, and a Bots role for bot accounts:

```yaml
plugins:
  autorole:
    config:
      roles:
        - role: "1111111111111111111"
          delay_ms: 0
        - role: "2222222222222222222"
          delay: "30s"
      bot_roles:
        - role: "3333333333333333333"
          delay_ms: 0
```

Or configure in Discord:

1. `/autorole add` → Humans only → welcome role, delay `0`
2. `/autorole add` → Humans only → verified role, delay `30s`
3. `/autorole add` → Bots only → bots role, delay `0`
4. `/autorole list` to review
