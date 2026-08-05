# Automod plugin

Automatic moderation for duplicate messages, rate limits, and join raids. Dreamliner evaluates messages and member joins against configurable rules and takes action when thresholds are exceeded.

**Automod is disabled by default.** Enable it when you're ready with `/plugin toggle plugin:automod state:Enable`. Rule defaults are preconfigured in the template so you can turn it on without extra setup.

## Configuration

```yaml
plugins:
  automod:
    enabled: false
    config:
      enabled_rules:
        - duplicate
        - rate_limit
      duplicate_window_ms: 30000
      duplicate_max: 3
      rate_limit_count: 5
      rate_limit_window_ms: 10000
      raid_join_count: 10
      raid_join_window_ms: 30000
      ignored_channels: []
      ignored_roles: []
      action: delete
      mute_duration_ms: 600000
    overrides:
      - level: ">=50"
        config:
          can_status: true
          can_test: true
          can_configure: true
```

| Field | Description |
|-------|-------------|
| `enabled` | Master switch (`false` by default). Use `/plugin toggle` or set in YAML |
| `enabled_rules` | Active rule types: `duplicate`, `rate_limit`, `raid` |
| `duplicate_window_ms` | Time window for duplicate detection |
| `duplicate_max` | Max identical messages in the window |
| `rate_limit_count` | Max messages allowed in the rate-limit window |
| `rate_limit_window_ms` | Rate-limit time window |
| `raid_join_count` | Joins that trigger raid detection |
| `raid_join_window_ms` | Raid detection time window |
| `ignored_channels` | Channel IDs excluded from automod |
| `ignored_roles` | Role IDs excluded from automod |
| `action` | `delete`, `warn`, or `mute` when a rule triggers |
| `mute_duration_ms` | Mute duration when action is `mute` |
| `log_channel_id` | Optional override; defaults to server `moderation_log_channel_id` |

Automod actions and raid alerts are logged to `moderation_log_channel_id` using the same format as other moderation logs.

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/automod status` | `can_status` | Show current automod settings |
| `/automod test` | `can_test` | Test sample text against active rules |
| `/automod configure` | `can_configure` | Update common automod settings |
| `/automod ignore-channel` | `can_configure` | Ignore or un-ignore a channel |
| `/automod ignore-role` | `can_configure` | Ignore or un-ignore a role |

## Requirements

- For `mute` action, the bot applies a Discord timeout using `mute_duration_ms` (defaults to 10 minutes if unset).
- Members with ignored roles are skipped.
- Bot messages are not checked.
