# Scam Protect plugin

Honeypot channel that softbans anyone who posts in it. Scam bots that spam every channel from the top of the server down hit this channel early, get softbanned, and have their recent messages deleted.

## How it works

1. You enable Scam Protect in the dashboard (or run `/scamprotect setup`). It is **off by default**.
2. Dreamliner creates a text channel whose name looks like `scamprotect`, using Cyrillic lookalikes (with a fullwidth fallback if Discord collapses them). You can prepend a prefix (emoji allowed) from the dashboard.
3. The channel is moved to the **top** of the channel list.
4. A Components v2 warning (colorless container, no image) with a **Caught** button that shows how many accounts have been softbanned.
5. When a non-ignored member (or bot) sends anything in that channel, Dreamliner softbans them (ban + unban) using your Infractions `softban_delete_message_days` setting (default 7 days of message deletion).

## Configuration

```yaml
plugins:
  scam_protect:
    enabled: false
    config:
      # Filled automatically after setup
      channel_id: ""
      warning_message_id: ""
      channel_prefix: ""
      ignored_roles: []
```

| Field | Description |
|-------|-------------|
| `enabled` | Must be `true` to activate (opt-in; off by default). Disabling from the dashboard also deletes the honeypot channel. |
| `channel_id` | Honeypot channel ID (set by setup / auto-create) |
| `warning_message_id` | Warning message ID |
| `channel_prefix` | Optional prefix prepended to the channel name (emoji allowed, e.g. `🚨`) |
| `ignored_roles` | Members with any of these roles are ignored, in addition to Ban Members, Administrators, and the owner |

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/scamprotect setup` | `can_setup` | Enable the plugin and create or repair the honeypot |
| `/scamprotect status` | `can_status` | Show whether the honeypot is active |

Grant `can_setup` and `can_status` to a Dreamliner Role on the dashboard's **Roles** page (or
`/permissions role grant`) — see [permissions.md](../permissions.md).

## Requirements

- Bot needs **Manage Channels** (create / position the honeypot).
- Bot needs **Ban Members** (softban).
- Softban message deletion uses `plugins.infractions.config.softban_delete_message_days`.

## Setup

1. In the dashboard, open **Scam Protect**.
2. Optionally set a channel prefix.
3. Click **Create Scam Protect channel**. Dreamliner enables the plugin, creates the honeypot, and posts the warning. Channel and message IDs are managed by the bot and are not editable.
4. Or run `/scamprotect setup` in Discord.
5. Keep the bot's role high enough to softban typical scam bots.

Staff and anyone with Ban Members / Administrator can still type in the channel without being banned, so they can test carefully if needed.
