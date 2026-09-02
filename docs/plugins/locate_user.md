# Locate user plugin

Find which voice channel a member is currently in, and when they were last seen in the server.

## Configuration

```yaml
plugins:
  locate_user:
    enabled: true
```

Grant `can_locate` and `can_seen` to a Dreamliner Role on the dashboard's **Roles** page (or
`/permissions role grant`) — see [permissions.md](../permissions.md).

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/locate` | `can_locate` | Show a member's current voice channel |
| `/seen` | `can_seen` | Show when a member was last active, using Discord timestamps |

## Requirements

- `/locate` returns a channel mention when the member is in voice, or a not-in-voice message otherwise.
- `/seen` uses the latest recorded chat, voice, or staff event for that member. The time is shown as a Discord timestamp (`<t:…:F>` with a relative `<t:…:R>`).
- Both commands work for members the bot can see. `/seen` can still report last activity after someone has left, if that activity was recorded.
