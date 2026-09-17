# Social Notifications plugin

Live YouTube upload notifications. Point Dreamliner at a channel, pick where posts go, and every new upload gets announced automatically — no polling scripts or third-party webhooks required.

## How it works

1. From the dashboard, add a YouTube channel (by handle or URL) and pick which Discord channel new uploads post to.
2. Dreamliner checks each configured channel's uploads every 5 minutes.
3. When a new video is found, it posts a message to the configured channel — a plain text mention by default, or a fully custom Discord embed if you enable one.
4. Mention roles, message text, and the embed (title, description, color, author, thumbnail, image, footer, fields, and up to 5 link buttons) are all configured per-watcher from the dashboard.

Watchers, their last-seen video, and check history are all dashboard-managed data, not YAML config — there's nothing to hand-edit here.

## Limits

| Tier | Watchers |
|------|----------|
| Free | 10 |
| Dreamliner One | 50 |

## Configuration

```yaml
plugins:
  social:
    enabled: true
    config: {}
```

| Field | Description |
|-------|-------------|
| `enabled` | Turn the plugin off to stop all watchers without deleting them. |
| `can_manage` | Create, edit, and delete social notifications (dashboard). |
| `can_view` | View social notifications and run `/social`. |

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/social` | `can_view` | List this server's configured notifications and how many of your watcher slots are used |

Grant `can_view` and `can_manage` to a Dreamliner Role on the dashboard's **Roles** page (or `/permissions role grant`) —
see [permissions.md](../permissions.md).

## Placeholders

Message text, embed fields, and button URLs support:

| Placeholder | Value |
|-------------|-------|
| `{channel_name}` | The YouTube channel's display name |
| `{channel_url}` | The YouTube channel's URL |
| `{video_title}` | The new video's title |
| `{video_url}` | The new video's URL |

## Requirements

- The bot needs **Send Messages** and **Embed Links** in the target Discord channel.
- Mention roles need to be mentionable by the bot, or have **Mention @everyone, @here, and All Roles** where relevant.

## Setup

1. Open the dashboard's **Social Notifications** page.
2. Add a watcher: paste the YouTube channel's handle or URL and pick a Discord channel.
3. Optionally enable and customize the embed, add mention roles, or add link buttons.
4. Save. Dreamliner picks up new uploads on its next check, within 5 minutes.
