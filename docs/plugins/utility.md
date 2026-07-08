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
| `can_info` | `/info` |

### Settings

| Key | Default | Description |
|-----|---------|-------------|
| `jumbo_size` | `128` | Pixel size for `/jumbo` (max 2048) |
| `autojoin_threads` | `true` | Bot auto-joins new threads |
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

Bot version, uptime, loaded plugins, with link buttons for documentation, repository, terms, and privacy.

### `/help`

Browse commands by plugin with **Previous** / **Next** and a **Documentation** link button on the first row, plus a **plugin dropdown** on the second row. Optionally pass `query` to search across all commands.

### `/reload`

Hot-reload guild configuration from the database.

### `/avatar`

Display a user's avatar (2048px).

### `/jumbo`

Enlarge a custom server emoji. Size from `jumbo_size` config.

---

## Events

When `autojoin_threads` is enabled, Dreamliner automatically joins new public threads so it can read and respond in thread channels.
