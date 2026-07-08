# Counters plugin

Display live server statistics in a channel message. Counters can track members, messages, or a custom value.

## Configuration

```yaml
plugins:
  counters:
    enabled: true
    overrides:
      - level: ">=50"
        config:
          can_create: true
          can_set: true
          can_delete: true
```

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/counter create` | `can_create` | Create a counter (`members`, `messages`, or `custom`) |
| `/counter set` | `can_set` | Set a counter value manually |
| `/counter delete` | `can_delete` | Delete a counter by name |

## Requirements

- The bot needs **Send Messages** and **Manage Messages** in the display channel.
- `members` counters update on join/leave events.
- `messages` counters update when messages are sent in the server.
