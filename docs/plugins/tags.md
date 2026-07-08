# Tags plugin

Store reusable text snippets that staff can post with slash commands.

## Configuration

```yaml
plugins:
  tags:
    enabled: true
    overrides:
      - level: ">=50"
        config:
          can_create: true
          can_edit: true
          can_delete: true
          can_list: true
          can_show: true
```

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/tag create` | `can_create` | Create a new tag |
| `/tag edit` | `can_edit` | Edit tag content |
| `/tag delete` | `can_delete` | Delete a tag |
| `/tag list` | `can_list` | List all tags |
| `/tag show` | `can_show` | Display a tag's content |

## Requirements

- Tags are stored per server in the Dreamliner database.
- Tag names are case-sensitive.
