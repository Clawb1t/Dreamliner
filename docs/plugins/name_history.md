# Name history plugin

Look up past usernames and nicknames stored by Dreamliner.

## Configuration

```yaml
plugins:
  name_history:
    enabled: true
```

Grant `can_view` and `can_search` to a Dreamliner Role on the dashboard's **Roles** page (or
`/permissions role grant`) — see [permissions.md](../permissions.md).

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/names user` | `can_view` | View name history for a user |
| `/names search` | `can_search` | Search name history by user ID or name fragment |

## Requirements

- History is built from nickname changes logged by Dreamliner and username snapshots from the Username Saver plugin.
- Works best when both Name History and Username Saver are enabled.
