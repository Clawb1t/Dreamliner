# Roles plugin

Give, remove, and list roles on members from slash commands.

## Configuration

```yaml
plugins:
  roles:
    enabled: true
```

Grant `can_give`, `can_remove`, and `can_list` to a Dreamliner Role on the dashboard's **Roles** page (or
`/permissions role grant`) — see [permissions.md](../permissions.md).

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/roles give` | `can_give` | Give a role to a member |
| `/roles remove` | `can_remove` | Remove a role from a member |
| `/roles list` | `can_list` | List a member's roles |

## Requirements

- The bot needs **Manage Roles**.
- The bot's highest role must be above any role it assigns or removes.
- Managed roles (integrations, bot roles) cannot be changed.
