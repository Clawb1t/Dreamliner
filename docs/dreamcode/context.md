# Dreamcode runtime context

Every invocation builds a **globals** object from the Discord message. Locals from `set` shadow globals. Website autocomplete should offer these paths.

## Top-level globals

| Path | Type | Description |
|------|------|-------------|
| `invoker` | member | Who ran the command |
| `user` | member | Alias of `invoker` |
| `guild` | guild | Current server |
| `channel` | channel | Channel where the command was used |
| `trigger` | message | The invoking message |
| `arg` | args | Parsed arguments after the command name |
| `bot` | bot | The bot user |
| `logs` | logs | Configured log channel ids |
| `result` | any | Return value of the last action (`null` initially) |

---

## `invoker` / member objects

Produced for `invoker` and by `get_member`.

| Path | Type | Description |
|------|------|-------------|
| `.id` | string | Snowflake |
| `.name` | string | Username |
| `.displayName` | string | Display name |
| `.nick` | string \| null | Nickname |
| `.mention` | string | `<@id>` |
| `.tag` | string | Username#… / tag |
| `.bot` | boolean | Is bot |
| `.level` | number | Dreamliner permission level |
| `.timedOut` | boolean | Communication disabled |
| `.joinedAt` | number \| null | Join time (ms) |
| `.joinedAtIso` | string \| null | ISO timestamp |
| `.avatarUrl` | string | Avatar URL |
| `.roles` | role[] | Roles highest-first (excludes @everyone) |
| `.roleIds` | string[] | Role id list |
| `.highestRole` | role \| null | Top role |
| `.voiceChannelId` | string \| null | Current VC id |
| `.voiceChannel` | channel \| null | Current VC object |

---

## `guild`

| Path | Type |
|------|------|
| `.id` | string |
| `.name` | string |
| `.memberCount` | number |
| `.ownerId` | string |
| `.iconUrl` | string \| null |
| `.createdAt` | number (ms) |

---

## `channel` / role / message / user

### channel

| Path | Type |
|------|------|
| `.id` `.name` `.mention` | string |
| `.type` | number \| null (Discord channel type) |
| `.parentId` | string \| null |
| `.topic` | string \| null |
| `.nsfw` | boolean |
| `.slowmode` | number (seconds) |

### role

| Path | Type |
|------|------|
| `.id` `.name` `.mention` | string |
| `.color` | string (hex) |
| `.position` | number |
| `.mentionable` `.managed` `.hoist` | boolean |
| `.members` | number (cached size) |

### message (`trigger`, `reply`/`send` returns)

| Path | Type |
|------|------|
| `.id` `.content` `.channelId` `.authorId` | string |
| `.createdAt` | number |
| `.pinned` | boolean |
| `.url` | string |

### user (`get_user`)

| Path | Type |
|------|------|
| `.id` `.name` `.mention` `.tag` | string |
| `.bot` | boolean |
| `.level` | number (0 if not in guild) |
| `.avatarUrl` | string |
| `.createdAt` `.createdAtIso` | number / string |

---

## `arg`

Built from slash options (typed `@slash arg …`) or the legacy freeform `args` string option.

Example: `/ban` with option `target=@Target` and `reason=being rude` → `arg.target`, `arg.reason`

| Path | Type | Description |
|------|------|-------------|
| `arg.rest` | string | Full remainder after command name |
| `arg.count` | number | Token count |
| `arg.1` … `arg.20` | string \| null | Tokens (quoted strings keep spaces) |
| `arg.user` | member/user \| null | First user mention or snowflake token |
| `arg.role` | role \| null | First role mention |
| `arg.channel` | channel \| null | First channel mention |

Tokenization: whitespace-split, or `"quoted blocks"`.

---

## `bot`

| Path | Type |
|------|------|
| `.id` `.name` `.mention` | string |

---

## `logs`

| Path | Type |
|------|------|
| `.moderationChannelId` | string \| null |
| `.serverChannelId` | string \| null |

---

## Case objects (from mod / case actions)

| Path | Type |
|------|------|
| `.id` | number |
| `.type` | string (`warn`, `ban`, `tempmute`, …) |
| `.userId` `.modId` | string |
| `.reason` | string |
| `.active` | boolean |
| `.expiresAt` | number \| null |
| `.createdAt` | number |

---

## Entity equality

`arg.user == invoker` compares `.id` when both sides are objects with an `id` field.

---

## Enrichment via lookup actions

Prefer these when you need live Discord state beyond the snapshot globals:

- `get_member`, `get_user`, `get_role`, `get_channel`, `get_message`
- `member_level`, `has_role`, `is_timed_out`, `is_banned`, `locate`
- `case_get`, `case_search`, `case_count`
- `tag_get`, `counter_get`, `name_history`, `message_count`, `snowflake_info`
