# Tags plugin

Store reusable text snippets that staff can post with slash commands or manage from the Dreamliner dashboard.

## Configuration

```yaml
plugins:
  tags:
    enabled: true
```

Grant `can_create`, `can_edit`, `can_delete`, `can_list`, and `can_show` to a Dreamliner Role on the dashboard's
**Roles** page (or `/permissions role grant`) — see [permissions.md](../permissions.md).

## Dashboard

Open the **Tags** plugin in the dashboard to list, create, edit, and delete tags. Tag content supports placeholders like `{user}`, `{guild}`, and `{memberCount}`.

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/tag create` | `can_create` | Create a new tag |
| `/tag edit` | `can_edit` | Edit tag content |
| `/tag delete` | `can_delete` | Delete a tag |
| `/tag list` | `can_list` | List all tags |
| `/tag show` | `can_show` | Display a tag's content |

## Notes

- Tags are stored per server in the Dreamliner database (not in YAML config).
- Tag names are stored lowercase (`Rules` becomes `rules`).
- Names must start with a letter or number and may include `_` or `-`.
