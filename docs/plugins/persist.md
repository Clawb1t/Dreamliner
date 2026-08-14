# Persist plugin

Keep a sticky message at the bottom of a channel. Configure stickies from the **dashboard only** — there are no Discord commands.

When someone posts in that channel, Dreamliner waits for the configured delay, then deletes the previous sticky and resends it so it stays last. Further messages during the delay reset the timer.

Stickies can be plain text, a full Discord embed, link buttons, or any mix of those.

## Configuration

```yaml
plugins:
  persist:
    enabled: true
    config:
      messages:
        - enabled: true
          name: "Rules"
          channel_id: "123456789012345678"
          content: "Please read the rules before chatting in {channel}."
          delay_seconds: 20
          silent: true
          embed:
            enabled: true
            title: "{guild} rules"
            description: "Be kind. No spam. Follow Discord TOS."
            color: 5661430
            thumbnail: guild
            footer_text: "Thanks for being here"
            timestamp: true
          buttons:
            - label: "Full rules"
              url: "https://example.com/rules"
              emoji: "📜"
```

### Sticky fields

| Field | Description |
|-------|-------------|
| `enabled` | Turn this sticky on or off without deleting it |
| `name` | Dashboard label (also used as webhook username fallback) |
| `channel_id` | Channel to keep the sticky in |
| `content` | Optional text above the embed. Supports `{guild}`, `{channel}`, `{channel_name}`, `{member_count}`, `{guild_icon_url}` |
| `delay_seconds` | Seconds to wait after the latest message before bumping. `0` resends immediately |
| `embed` | Optional Discord embed (title, description, color, author, thumbnail, image, footer, fields, timestamp) |
| `buttons` | Up to 5 link buttons under the message |
| `webhook` | Send with a custom name and avatar (needs **Manage Webhooks**) |
| `webhook_name` / `webhook_avatar_url` | Custom webhook appearance |
| `silent` | Suppress notification pings |
| `suppress_embeds` | Do not unfurl links in the text |
| `mention_users` / `mention_roles` / `mention_everyone` | What the sticky text is allowed to ping |
| `ignore_bots` / `ignore_webhooks` | Skip bumping when bots or webhooks post |

Embed icon sources (`author_icon`, `thumbnail`, `footer_icon`) are `none`, `guild`, `bot`, or `url` (then set the matching `*_url`).

Saving the dashboard config posts missing stickies, updates content/embeds that changed, and removes stickies you deleted or disabled.

## Behaviour

- Every new message in a configured channel schedules a bump after `delay_seconds`.
- The bot ignores its own sticky posts (including persist webhooks) so it does not loop.
- If someone deletes the sticky, it is posted again immediately.
- On startup, missing stickies are posted; existing ones are left in place until the next bump or a dashboard save that changes them.

## Requirements

- **Send Messages** and **Read Message History** in the target channel.
- **Manage Webhooks** only if `webhook: true`.
- Manage Messages is not required to delete the bot's own previous sticky. Webhook stickies are deleted through the persist webhook.
