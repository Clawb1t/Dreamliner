# Infractions plugin

Infraction tracking and moderation commands for Dreamliner.

## Commands

### Punishment commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/warn` | `can_warn` | Issue a warning |
| `/note` | `can_note` | Add a staff note |
| `/mute` | `can_mute` | Timeout a member via Discord (max 28d; `duration` optional if `default_duration.tempmute` is set) |
| `/unmute` | `can_mute` | Clear a member's Discord timeout |
| `/kick` | `can_kick` | Kick a member |
| `/ban` | `can_ban` | Permanently ban a member |
| `/tempban` | `can_ban` | Temporarily ban a member (`duration` optional if `default_duration.tempban` is set) |
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
      case_log_channel: "1234567890123456789"  # Optional; falls back to moderation_log_channel_id
      ban_delete_message_days: 0
      softban_delete_message_days: 7
      notify:
        warn:
          dm: true
        mute:
          dm: false
      require_reason:            # Per-action: reject the command if no reason is given
        warn: true
        ban: true
      default_duration:          # Fallback duration (ms) when the command's duration option is blank
        tempmute: 600000          # 10m
        tempban: 86400000         # 1d
      escalation:                 # Auto-escalation ladder for repeat offenders
        enabled: true
        count_types: ["warn"]     # Which infraction types count toward the strike total
        window_ms: 0              # 0 = count all-time; otherwise only strikes within this window
        steps:
          - after: 3
            type: mute
            duration_ms: 1800000  # 30m
          - after: 5
            type: ban
```

Grant `can_warn`, `can_note`, `can_mute`, `can_kick`, `can_ban`, `can_unban`, `can_softban`, `can_view`,
`can_edit_reason`, `can_edit_duration`, and `can_delete` to a Dreamliner Role on the dashboard's **Roles** page
(or `/permissions role grant`) — see [permissions.md](../permissions.md). Editing another moderator's case only
requires the same `can_edit_reason`/`can_edit_duration` permission as editing your own — there's no separate
elevated threshold.

## Auto-escalation

When `escalation.enabled` is `true`, Dreamliner counts a member's qualifying infractions (`escalation.count_types`, within `escalation.window_ms` if set) after every punishment command. If the new total exactly matches a step's `after` value, that step's punishment is applied automatically and logged as its own case with reason `Auto-escalation: reached N infractions`. Steps only fire on an exact match, so keep `after` values strictly increasing (e.g. 3, 5, 8).

Configure all of this — punishment-specific reason requirements, default durations, and the escalation ladder — from the dashboard's Infractions page, which opens each punishment type into its own settings panel similar to Automod.

## Duration format

Timed actions use Dreamliner duration formats: `30s`, `5m`, `2h`, `1d`, `1w`.

## Expiration

Timed mutes and bans are checked every minute. When a tempmute or tempban expires, the bot clears the timeout or unbans the user and marks the infraction inactive.

Manual `/unmute` or `/unban` also clears active infraction records.

## Case log

When `case_log_channel` (or the server `moderation_log_channel_id`) is set, each action posts a log line to that channel. Case updates, deletions, and expirations are also logged there.
