# Utility plugin

The Utility plugin provides server management, search, info, message tools, voice helpers, and bot meta commands. All commands are slash commands and gated by `can_*` config flags.

## Permission flags

| Flag | Command(s) |
|------|------------|
| `can_search` | `/search`, `/bansearch` |
| `can_clean` | `/clean` |
| `can_userinfo` | `/user` |
| `can_server` | `/server` |
| `can_channelinfo` | `/channel` |
| `can_messageinfo` | `/message` |
| `can_inviteinfo` | `/invite` |
| `can_roleinfo` | `/role` |
| `can_emojiinfo` | `/emoji` |
| `can_snowflake` | `/snowflake` |
| `can_roles` | `/rolelist` |
| `can_level` | `/level` |
| `can_context` | `/context` |
| `can_source` | `/source` |
| `can_nickname` | `/nickname` |
| `can_vcmove` | `/voice move`, `/voice move-all` |
| `can_vckick` | `/voice disconnect` |
| `can_ping` | `/ping` |
| `can_about` | `/about` |
| `can_help` | `/help` |
| `can_reload_guild` | `/reload` |
| `can_avatar` | `/avatar` |
| `can_jumbo` | `/jumbo` |
| `can_stealemoji` | `/stealemoji` |
| `can_info` | `/info` |
| `can_convert_gif` | **Convert to GIF** (message context menu) |
| `can_create_quote` | **Create Quote** (message context menu) |

### Settings

| Key | Default | Description |
|-----|---------|-------------|
| `jumbo_size` | `128` | Pixel size for `/jumbo` (max 2048) |
| `autojoin_threads` | `true` | Bot auto-joins new threads |
| `expand_message_links` | `true` | Paste a Discord message link to expand it in chat |
| `info_on_single_result` | `true` | `/search` shows user info when exactly one match |

---

## Search

### `/search`

Search members by username or nickname.

| Option | Description |
|--------|-------------|
| `query` | Search text |
| `page` | Page number |
| `in_voice` | Only members in voice |
| `bots_only` | Only bots |
| `case_sensitive` | Case-sensitive match |
| `regex` | Treat query as regex |
| `ids_only` | Output user IDs only |
| `sort` | `name`, `joined`, `created`, or `level` |

### `/bansearch`

Search banned users. Requires **Ban Members** Discord permission.

| Option | Description |
|--------|-------------|
| `query` | Search text (required) |
| `page` | Page number |
| `case_sensitive` | Case-sensitive match |
| `regex` | Treat query as regex |

---

## Info commands

### `/info`

Auto-detect target type (channel, role, user, invite, snowflake) from a string.

### `/user`

User information including infraction and message stats for this server and globally. Message counts are tracked by Dreamliner from when the bot is running. Defaults to yourself.

| Option | Description |
|--------|-------------|
| `member` | Target user |
| `compact` | Shorter output |

### `/server`

Information about the current server.

### `/channel`

Channel information. Defaults to current channel.

### `/message`

Message information by ID (current channel).

### `/invite`

Invite code or URL information.

### `/role`

Role information.

### `/emoji`

Custom emoji information.

### `/snowflake`

Decode a Discord snowflake ID (timestamp, worker, process, increment).

### `/rolelist`

List server roles.

| Option | Description |
|--------|-------------|
| `counts` | Show member counts |
| `sort` | `name`, `position`, or `memberCount` |

### `/level`

Show a member's config permission level.

---

## Message tools

### `/clean`

Bulk delete messages. Requires **Manage Messages**.

| Option | Description |
|--------|-------------|
| `amount` | Messages to scan (1–100, required) |
| `user` | Only from this user |
| `bots_only` | Only bot messages |
| `pins_only` | Only pinned messages |
| `contains_invite` | Only messages with invite links |
| `regex` | Content filter regex |
| `update_case` | Record a mod case entry |

Deleted messages are archived to the database. Discord only allows bulk-deleting messages **less than 14 days old**.

### `/context`

Link to the message immediately before a given message ID.

### `/source`

Export full message JSON as a file attachment. Archived in the database.

---

## Nicknames

### `/nickname set`

Set a member's nickname (2–32 characters). Requires **Manage Nicknames** when changing others.

### `/nickname reset`

Clear a member's nickname.

### `/nickname view`

Show current nickname.

---

## Voice

### `/voice move`

Move a member to a voice channel. Requires **Move Members**. Logged to `moderation_log_channel_id` if set.

### `/voice move-all`

Move all members from one voice channel to another.

### `/voice disconnect`

Disconnect a member from voice.

---

## Meta

### `/ping`

Latency test (roundtrip and WebSocket).

### `/about`

Bot version, uptime, runtime stats, and loaded plugins, with link buttons for [documentation](https://dreamliner.gitbook.io/dreamliner-docs/docs), terms, and privacy.

### `/help`

Browse every command through a slim category home screen. Categories include **Moderation**, **Protection**, **Role management**, **Self-serve roles**, **Lookups**, **Engagement**, **Auto responses**, **Scheduling**, **Customization**, **Utilities**, **Feedback**, and **Configuration**.

- Category menu jumps between topics
- Command menu opens usage details and options
- **Home** / **Back** / **Previous** / **Next** for navigation, plus a **Docs** link
- Optional `query` searches across all commands (e.g. `/help query:ban`)

### `/reload`

Hot-reload guild configuration from the database.

### `/avatar`

Display a user's avatar (2048px).

### `/jumbo`

Enlarge a custom server emoji. Size from `jumbo_size` config.

### `/stealemoji`

Copy a custom emoji into this server from its markup. Works even if Dreamliner is not in the source server (uses Discord’s CDN). Requires **Manage Expressions** for both you and the bot.

| Option | Description |
|--------|-------------|
| `emoji` | Custom emoji to steal (required), e.g. `<:name:id>` or `<a:name:id>` |
| `name` | Optional new name (2-32 letters, numbers, underscores) |

Unicode emoji cannot be stolen. Animated and static emojis both work, subject to the server’s remaining emoji slots.

---

## Message context menu commands

Right-click a message → **Apps** to use these commands.

### Convert to GIF

Converts image file attachments on the target message to GIF format so members can favorite them in Discord. Replies publicly on success with the GIF(s) and a short hint; failures are ephemeral.

Requires `can_convert_gif`.

### Create Quote

Renders a quote card GIF from the target message text, with the author's avatar in grayscale on the left and quote text on the right. Includes a **Remove my quote** button that only the quoted person can use to revoke the image. Replies publicly with the GIF; failures are ephemeral.

Requires `can_create_quote`.

---

## Events

When `autojoin_threads` is enabled, Dreamliner automatically joins new public threads so it can read and respond in thread channels.

### Message link expand

When `expand_message_links` is enabled (default on), pasting a Discord message link in chat makes Dreamliner fetch that message and repost it:

- Original author name and avatar (via webhook, same style as auto-translate)
- Message content, embeds, and attachments
- Small “Message found by Dreamliner” footer with a jump link

Requires **Manage Webhooks** for the bot in that channel. If webhooks are unavailable, Dreamliner falls back to a normal bot message. Toggle this in the dashboard under Utility plugin settings.
