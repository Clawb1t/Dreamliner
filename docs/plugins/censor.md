# Censor plugin

Block or warn on messages matching configured word or pattern rules. Rules can use plain text or regex.

## Configuration

```yaml
plugins:
  censor:
    enabled: true
    config:
      rules:
        - pattern: "badword"
          regex: false
          action: delete
      ignored_channels: []
    overrides:
      - level: ">=50"
        config:
          can_list: true
          can_add: true
          can_remove: true
```

| Field | Description |
|-------|-------------|
| `rules` | List of patterns with `pattern`, `regex`, and `action` (`delete` or `warn`) |
| `ignored_channels` | Channel IDs where censor rules do not apply |

Matched messages are logged to `moderation_log_channel_id`.

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/censor list` | `can_list` | List censor rules |
| `/censor add` | `can_add` | Add a censor rule |
| `/censor remove` | `can_remove` | Remove a rule by ID |

## Requirements

- The bot needs **Manage Messages** to delete matched messages.
- For `warn` action, the Infractions plugin must be enabled with `can_warn` for the acting moderator level.
