# Name history plugin

Look up past usernames and nicknames stored by Dreamliner.

## Configuration

```yaml
plugins:
  name_history:
    enabled: true
    overrides:
      - level: ">=50"
        config:
          can_view: true
          can_search: true
```

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/names user` | `can_view` | View name history for a user |
| `/names search` | `can_search` | Search name history by user ID or name fragment |

## Requirements

- History is built from nickname changes logged by Dreamliner and username snapshots from the Username Saver plugin.
- Works best when both Name History and Username Saver are enabled.
