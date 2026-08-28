# Counters plugin

Display live server statistics — members, messages, boosts, or a manually-set custom value — in a channel. Configure counters from the **dashboard only**; there are no Discord commands.

Each counter can display as an embed message in a text channel, or as the live-updating *name* of a text or voice channel.

## Configuration

```yaml
plugins:
  counters:
    enabled: true
    config:
      counters:
        - enabled: true
          name: "members"
          metric: members
          display: message
          channel_id: "123456789012345678"
          format: "👥 Members: {value}"
        - enabled: true
          name: "member-count"
          metric: members
          display: voice_name
          channel_id: "234567890123456789"
          format: "Members: {value}"
          refresh_minutes: 10
        - enabled: true
          name: "hype"
          metric: custom
          display: message
          channel_id: "123456789012345678"
          format: "🔥 Hype: {value}"
          value: 0
```

### Counter fields

| Field | Description |
|-------|-------------|
| `enabled` | Turn this counter on or off without deleting it |
| `name` | Counter label. Shown in the dashboard and, for message display, in the embed |
| `metric` | What it tracks: `members`, `messages`, `boosts` (server boost count), or `custom` |
| `display` | Where to show it: `message` (embed in a text channel), `channel_name` (renames a text channel), or `voice_name` (renames a voice channel) |
| `channel_id` | Channel to display in — a text channel for `message`/`channel_name`, a voice channel for `voice_name` |
| `format` | Template for the shown text. `{value}` is replaced with the formatted count |
| `refresh_minutes` | Minimum minutes between channel renames for `channel_name`/`voice_name` display (min 5). Ignored for `message` display |
| `value` | Current value. Kept in sync automatically for `members`/`messages`/`boosts`; set this directly for `custom` counters |

Saving the dashboard config creates missing counters, updates ones that changed, and removes ones you deleted or disabled.

## Behaviour

- `members` counters update on join/leave.
- `messages` counters increment on every message sent in the server.
- `boosts` counters update when the server's boost count changes.
- `custom` counters only change when you edit `value` in the dashboard.
- **Message display** updates immediately.
- **`channel_name`/`voice_name` display** is throttled to `refresh_minutes`. Discord allows at most 2 channel renames per 10 minutes, so the channel name lags behind the real count. A background sweep checks every counter roughly once a minute and renames it once its interval has elapsed and the value has actually changed.
- On startup, missing counters are created and displays are refreshed.

## Requirements

- **Send Messages** in the display channel for `message` display.
- **Manage Channels** in the display channel for `channel_name`/`voice_name` display.
