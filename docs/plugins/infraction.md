# Infractions plugin

Infraction tracking and moderation commands for Dreamliner.

## Commands

### Punishment commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/warn` | `can_warn` | Issue a warning |
| `/note` | `can_note` | Add a staff note |
| `/mute` | `can_mute` | Mute a member (optional `duration` for timed mute) |
| `/unmute` | `can_mute` | Remove a mute |
| `/kick` | `can_kick` | Kick a member |
| `/ban` | `can_ban` | Permanently ban a member |
| `/tempban` | `can_ban` | Temporarily ban a member |
| `/unban` | `can_unban` | Unban by user ID |
| `/softban` | `can_softban` | Ban and immediately unban to purge messages |

### Case management

| Command | Permission | Description |
|---------|------------|-------------|
| `/infraction view` | `can_view` | View infraction details by ID |
| `/infraction search` | `can_view` | Search by ID, user, mod, or reason text |
| `/infraction reason` | `can_edit_reason` | Edit an infraction reason |
| `/infraction duration` | `can_edit_duration` | Extend or set duration (from creation time) |
| `/infraction delete` | `can_delete` | Delete an infraction record |

## Configuration

```yaml
plugins:
  infractions:
    config:
      mute_role: "1234567890123456789"      # Required for mute/unmute
      case_log_channel: "1234567890123456789"  # Optional; falls back to moderation_log_channel_id
      confirm_actions: true
      ban_delete_message_days: 0
      softban_delete_message_days: 7
      reason_edit_level: 100
      duration_edit_level: 100
      notify:
        warn:
          dm: true
        mute:
          dm: false
    overrides:
      - level: ">=50"
        config:
          can_warn: true
          can_mute: true
          can_view: true
```

## Duration format

Timed actions use Dreamliner duration formats: `30s`, `5m`, `2h`, `1d`, `1w`.

## Expiration

Timed mutes and bans are checked every minute. When a tempmute or tempban expires, the bot removes the mute role or unbans the user and marks the infraction inactive.

Manual unmute/unban or removing the mute role also clears active infraction records.

## Case log

When `case_log_channel` (or the server `moderation_log_channel_id`) is set, each action posts a log line to that channel. Case updates, deletions, and expirations are also logged there.
