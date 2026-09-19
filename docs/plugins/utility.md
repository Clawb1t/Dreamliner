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
| `can_watchdog` | `/watchdog` |
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
| `can_discofy` | `/discofy` |
| `can_info` | `/info` |
| `can_convert_gif` | **Convert to GIF** (message context menu) |
| `can_create_sticker` | **Create Sticker** (message context menu) |
| `can_create_emoji` | **Create Emoji** (message context menu) |
| `can_quote_to_discofy` | **Quote to Discofy** (message context menu) |
| `can_listening_to` | **Listening to** (user context menu) |

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

List the Dreamliner Roles a member belongs to.

### `/watchdog`

Show a member's Watchdog risk score, tier (Critical/Elevated/Watch/Low), and the full list of
signals that contributed to it — the same scoring shown on the dashboard's Watchdog page
(`GuildWatchdogPanel`), so a mod can pull the same read-out without leaving Discord.

| Option | Description |
|--------|-------------|
| `member` | Member to check (required) |

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

### `/vote`

Sends a link to vote for Dreamliner on [top.gg](https://top.gg/bot/1524053555114151946). Not gated by a
`can_*` flag — available to everyone as soon as the utility plugin is enabled.

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

### `/discofy`

Pull an avatar or banner from [Discofy](https://discofy.net). Requires `DISCOFY_API_KEY` (same key as the "Quote to Discofy" message context command).

| Option | Description |
|--------|-------------|
| `type` | `Avatar` or `Banner` (required) |
| `search` | Search for this instead of getting a random pick |

---

## Context menu commands

### Convert to GIF

Right-click a message → **Apps**. Converts image file attachments on the target message to GIF format so members can favorite them in Discord. Replies publicly on success with the GIF(s) and a short hint; failures are ephemeral.

Requires `can_convert_gif`.

### Create Sticker

Right-click a message → **Apps**. Steals an existing sticker on the message, or turns its first image attachment into one, and adds it to the server's stickers. Replies publicly on success; failures are ephemeral.

Requires `can_create_sticker` and the bot's own **Manage Expressions** permission.

### Create Emoji

Right-click a message → **Apps**. Steals the first custom emoji found in the message's text, or turns its first image attachment into one, and adds it to the server's emoji. Replies publicly on success; failures are ephemeral.

Requires `can_create_emoji` and the bot's own **Manage Expressions** permission.

### Quote to Discofy

Right-click a message → **Apps**. Submits the message's text (and first image attachment, if any) to the public Discofy feed. Replies publicly with the Discofy URL; failures are ephemeral. Requires `DISCOFY_API_KEY`.

Requires `can_quote_to_discofy`.

### Listening to (user context menu)

Right-click a member → **Apps**. Looks up that member's connected Last.fm account and shows what they're currently playing (or their most recent scrobble, worded "Last listened to" if nothing is playing right now) as a small card with the track, artist, and album art. Requires `LASTFM_API_KEY`, and requires the target member to have connected a Last.fm username at the dashboard's Account → Connections tab — if they haven't, the reply (ephemeral) links there. Replies publicly on success; all errors are ephemeral.

Requires `can_listening_to`.

---

## Events

When `autojoin_threads` is enabled, Dreamliner automatically joins new public threads so it can read and respond in thread channels.

### Message link expand

When `expand_message_links` is enabled (default on), pasting a Discord message link in chat makes Dreamliner fetch that message and repost it:

- Original author name and avatar (via webhook, same style as auto-translate)
- Message content, embeds, and attachments
- Small “Message found by Dreamliner” footer with a jump link

Requires **Manage Webhooks** for the bot in that channel. If webhooks are unavailable, Dreamliner falls back to a normal bot message. Toggle this in the dashboard under Utility plugin settings.
