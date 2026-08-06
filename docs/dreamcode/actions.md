# Dreamcode actions

Human-readable catalog. **Machine-readable source of truth for the website:** [`actions.catalog.json`](./actions.catalog.json) (regenerate with `npm run dreamcode:export`).

Code source: `src/dreamcode/actions.ts` (`ACTION_DEFS`).

Legend:

- **Mutates** — changes Discord or DB state  
- **Returns** — value available via `set x = …` or `result`

Parameter binding: positional left-to-right, then `name: value`. Types hint UI widgets (`user`, `role`, `channel`, `duration`, …).

---

## Messaging

| Key | Mutates | Returns | Signature |
|-----|---------|---------|-----------|
| `reply` | yes | message | `content` |
| `send` | yes | message | `channel`, `content` |
| `dm` | yes | boolean | `user`, `content` (guild members only) |
| `react` | yes | — | `emoji` (trigger message) |
| `react_message` | yes | — | `channel`, `message_id`, `emoji` |
| `delete_trigger` | yes | — | (none) |
| `edit_trigger` | yes | message | `content` (bot must own message) |
| `delete_message` | yes | — | `channel`, `message_id` |
| `pin` / `unpin` | yes | — | `channel`, `message_id` |
| `send_tag` | yes | message | `name`; named `channel?` |

---

## Moderation

All hierarchy-checked via `canModerateTarget`. Creates infraction cases + mod logs where applicable.

| Key | Mutates | Returns | Key params |
|-----|---------|---------|------------|
| `warn` | yes | case | `user`; `reason?` |
| `note` | yes | case | `user`; `reason?` |
| `kick` | yes | case | `user`; `reason?` |
| `ban` | yes | case | `user`; `reason?`, `delete_days?` |
| `tempban` | yes | case | `user`; **`duration`**, `reason?`, `delete_days?` |
| `unban` | yes | case | `user`; `reason?` |
| `softban` | yes | case | `user`; `reason?`, `delete_days?` |
| `mute` | yes | case | `user`; **`duration`**, `reason?` (max 28d) |
| `unmute` | yes | case | `user`; `reason?` |
| `clean` | yes | `{deleted, archiveId}` | `amount` (1–100); `channel?`, `user?`, `bots_only?`, `contains?`, `regex?` |

---

## Cases

| Key | Mutates | Returns | Params |
|-----|---------|---------|--------|
| `case_get` | no | case \| null | `id` |
| `case_search` | no | case[] | `query`; `type?` |
| `case_count` | no | number | `user` |
| `case_reason` | yes | case \| null | `id`, `reason` |
| `case_delete` | yes | boolean | `id` |

---

## Roles & nicknames

| Key | Mutates | Returns | Params |
|-----|---------|---------|--------|
| `add_role` / `remove_role` | yes | — | `user`, `role`; `reason?` |
| `toggle_role` | yes | boolean (added?) | `user`, `role`; `reason?` |
| `has_role` | no | boolean | `user`, `role` |
| `nickname` | yes | — | `user`, `nick` (`""` clears); `reason?` |
| `set_mentionable` | yes | — | `role`, `enabled` |

Uses `safeAddRole` / `safeRemoveRole` / `safeToggleRole` hierarchy rules.

---

## Voice

| Key | Mutates | Returns | Params |
|-----|---------|---------|--------|
| `voice_move` | yes | — | `user`, `channel`; `reason?` |
| `voice_disconnect` | yes | — | `user`; `reason?` |
| `voice_move_all` | yes | number moved | `from`, `to` |

Posts moderation voice logs.

---

## Channel / server

| Key | Mutates | Returns | Params |
|-----|---------|---------|--------|
| `slowmode` | yes | seconds | `seconds` (0–21600); `channel?` |
| `lock_channel` / `unlock_channel` | yes | — | `channel?` (@everyone or admin lockdown role) |
| `lockdown` / `unlock` | yes | `{updated,target}` | (none) — all text channels |
| `create_invite` | yes | url string | `channel?`, `max_age?`, `max_uses?` |

---

## Tags

| Key | Mutates | Returns | Params |
|-----|---------|---------|--------|
| `tag_get` | no | `{name,content}` \| null | `name` |
| `tag_create` | yes | tag | `name`, `content` |
| `tag_edit` | yes | boolean | `name`, `content` |
| `tag_delete` | yes | boolean | `name` |

---

## Counters

Counters must already exist (created via `/counter`).

| Key | Mutates | Returns | Params |
|-----|---------|---------|--------|
| `counter_get` | no | `{name,value,channelId}` \| null | `name` |
| `counter_set` | yes | new value | `name`, `value` |
| `counter_add` | yes | new value | `name`, `amount` (can be negative) |

---

## Reminders & posts

| Key | Mutates | Returns | Params |
|-----|---------|---------|--------|
| `remind` | yes | `{id,remindAt,…}` | `duration`, `message`; `user?`, `channel?` |
| `remind_cancel` | yes | boolean | `id`; `user?` |
| `schedule_post` | yes | `{id,nextRunAt,…}` | `channel`, `content`, `duration` |
| `schedule_post_cancel` | yes | boolean | `id` |

Durations convert to whole minutes (minimum 1) for the reminder/post schedulers.

---

## Logging

| Key | Mutates | Params |
|-----|---------|--------|
| `log_mod` | yes | `title`, `content`; `extra?` |
| `log_server` | yes | `title`, `content`; `extra?` |

Uses configured moderation / server log channels.

---

## Lookup

| Key | Returns | Params |
|-----|---------|--------|
| `get_member` | member \| null | `user` |
| `get_user` | user \| null | `user` |
| `get_role` | role \| null | `role` |
| `get_channel` | channel \| null | `channel` |
| `get_message` | message \| null | `channel`, `message_id` |
| `member_level` | number | `user` |
| `is_timed_out` | boolean | `user` |
| `is_banned` | boolean | `user` |
| `locate` | channel \| null | `user` (voice) |
| `name_history` | array | `user` (max 20) |
| `snowflake_info` | `{id,timestamp,iso}` | `id` |
| `message_count` | number | `user` (guild-scoped tracker) |

---

## Utility & control

| Key | Returns | Params |
|-----|---------|--------|
| `wait` | — | `duration` (counts against wait budget) |
| `random` | number | `min`, `max` (inclusive) |
| `choose` | string | `options` (`"a,b,c"`) |
| `length` | number | `value` (string or array) |
| `contains` | boolean | `haystack`, `needle`; `case_sensitive?` |
| `replace` | string | `value`, `search`, `replacement` |
| `upper` / `lower` / `trim` | string | `value` |
| `now` | number | (unix ms) |
| `format_time` | string | `ms`; `style?` (`R`\|`F`\|`D`\|…) |

---

## Intentionally not exposed

Guild config upload, `/permissions`, plugin toggles, Dreamcode command CRUD from scripts, automod/censor/autoreply rule managers, reaction-role panel builders, cross-guild stats, arbitrary Discord.js, eval.

See [website.md](./website.md) for editor integration rules.
