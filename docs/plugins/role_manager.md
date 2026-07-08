# Role manager plugin

Create reusable role name templates for per-member managed roles (for example `{user}-verified`).

## Configuration

```yaml
plugins:
  role_manager:
    enabled: true
    overrides:
      - level: ">=50"
        config:
          can_create: true
          can_delete: true
          can_list: true
```

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/rolemanage create` | `can_create` | Create a managed role template |
| `/rolemanage delete` | `can_delete` | Delete a template by name |
| `/rolemanage list` | `can_list` | List managed role templates |

## Requirements

- The bot needs **Manage Roles** when templates are applied to members.
- Template strings support placeholders such as `{user}`.
