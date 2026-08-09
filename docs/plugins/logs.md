# Logs plugin

Logging for server activity and moderation actions. The logs plugin has no commands - it listens to Discord events, stores audit rows, and posts to configured channels when toggles allow it.

## Configuration

```yaml
# Server events: joins, leaves, edits, deletes, channels, roles, voice, etc.
server_log_channel_id: "1234567890123456789"

# Moderation: infractions, automod, censor, cleans, voice mod, case updates
moderation_log_channel_id: "1234567890123456789"

# Per-event toggles (missing keys default to enabled)
logging:
  events:
    member_join: true
    message_delete: true
    voice_self_mute: false
```

Configure channels and toggles in the dashboard **Logging** section. Browse stored events in **Logs**.

The legacy `log_channel_id` field still works as a fallback for moderation logs if `moderation_log_channel_id` is not set.

Infraction case logs can optionally use a dedicated channel via `plugins.infractions.config.case_log_channel`, which overrides `moderation_log_channel_id` for case-related Discord posts only. Those events still appear in the dashboard Logs viewer.

## Storage

Every enabled event is stored in `guild_log_events` for **90 days** (used by the dashboard Logs page), even if no Discord log channel is set.

Message content snapshots for edit/delete reconstruction are still kept in `log_messages` for **42 days**.

## Log layout (Discord)

Each Discord log is a **Components v2** message:

- Colorless **container**
- **Section** with the member's avatar thumbnail (when available)
- Bold **title**
- **Information** block with labeled fields and snowflakes
- **Separator** + extra block for message content or before/after edits

`allowedMentions` is disabled on every log message.

## Server log coverage

Includes (toggleable): member join/leave/kick/ban/unban/timeout/nick/roles; message edit/delete/bulk delete/pin; channel and thread create/update/delete; role create/update/delete; guild update; emoji/sticker/invite/webhook changes; voice join/leave/move and mute/deafen/stream/video flags.

Where Discord provides audit logs, Dreamliner attaches the executor when available.

Bot accounts are excluded from member and message content logs.

## Moderation log coverage

Includes case create/update/delete/expire, automod, raid, censor, clean, voice mod actions, failed DMs, and Dreamcode mod logs. Dashboard Logs can open the linked case when `case_id` is present.
