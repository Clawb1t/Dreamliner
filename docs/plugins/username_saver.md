# Username saver plugin

Automatically records each member's current Discord username. This plugin has no commands - it runs in the background when members join or change their username.

## Configuration

```yaml
plugins:
  username_saver:
    enabled: true
    config:
      enabled: true
```

| Field | Description |
|-------|-------------|
| `enabled` | When `false`, username snapshots are not saved |

Set `enabled: false` on the plugin section to turn the plugin off entirely.

## Requirements

- Snapshots are stored in the Dreamliner database per user ID.
- Bot accounts are ignored.
- Used by the Name History plugin for username lookups.
