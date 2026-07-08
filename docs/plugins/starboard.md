# Starboard plugin

Posts popular messages to a dedicated channel when they collect enough star reactions. Configure named boards in YAML, set a channel and minimum stars, and Dreamliner handles the rest.

Starred messages are tracked in the database, so counts and starboard posts survive bot restarts.

## Configuration

```yaml
plugins:
  starboard:
    enabled: true
    config:
      ignored_channels: []
      boards:
        main:
          channel_id: "1234567890123456789"
          stars_required: 3
          enabled: true
          show_star_count: true
          copy_full_embed: true
          count_self_stars: false
          star_emoji:
            - "⭐"
```

| Field | Description |
|-------|-------------|
| `ignored_channels` | Channel IDs where star reactions are ignored (not posted to any board) |
| `channel_id` | Text channel where starred messages are posted |
| `stars_required` | Minimum number of star reactions needed |
| `enabled` | Turn this board on or off |
| `star_emoji` | Reaction emojis to count (default `⭐`). Supports custom emojis like `<:star:1234567890>` |
| `show_star_count` | Show the star count on a disabled button below the post |
| `copy_full_embed` | Include embeds from the original message |
| `count_self_stars` | When `true`, the message author's own star reaction counts (default `false`) |
| `color` | Optional embed color (decimal, e.g. `16744272`) |

You can define multiple boards with different names, channels, thresholds, or emojis:

```yaml
plugins:
  starboard:
    config:
      boards:
        main:
          channel_id: "1234567890123456789"
          stars_required: 5
        highlights:
          channel_id: "9876543210987654321"
          stars_required: 10
          star_emoji:
            - "🌟"
```

Set `enabled: false` on the plugin section to turn starboard off without removing your board settings.

## Behavior

- When a message reaches `stars_required` stars, the bot posts it to the starboard channel with a link back to the original.
- If reactions are removed and the count drops below the threshold, the starboard post is removed.
- If the original message is deleted, the starboard post is removed too.
- Bot messages and messages already in a starboard channel are ignored.
- Messages in channels listed under `ignored_channels` are ignored.
- By default, the message author's own star does not count. Set `count_self_stars: true` on a board to include it.

## Requirements

- The bot needs **Read Message History**, **Send Messages**, and **Embed Links** in the starboard channel.
- Reactions on older messages (including before a bot restart) are supported. The bot fetches uncached messages when someone reacts.

## Setup

1. Create a `#starboard` channel in Discord.
2. Run `/config download` or `/config template`.
3. Set `plugins.starboard.config.boards.main.channel_id` to your starboard channel ID.
4. Set `stars_required` to your preferred minimum (e.g. `3`).
5. Upload with `/config upload`.
