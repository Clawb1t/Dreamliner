# Configuration

Dreamliner server configuration is edited entirely from the **web dashboard** and stored as YAML in the database
under the hood — there is no in-Discord upload/download workflow anymore. The YAML shape below documents that
underlying format (and what a fork's `config/default.server.yaml` looks like), not something you write by hand.

## File format

```yaml
# Server events: joins, leaves, edits, deletes, voice activity, role/nickname changes
server_log_channel_id: "1111111111111111111"

# Moderation: infractions, automod, censor, /clean, voice mod, cases, expirations
moderation_log_channel_id: "1111111111111111111"

# Deprecated - use moderation_log_channel_id instead
# log_channel_id: "1234567890123456789"

# When true, command replies are only visible to the user who ran the command.
ephemeral_responses: false

plugins:
  utility:
    config:
      jumbo_size: 128
      autojoin_threads: true
      info_on_single_result: true
```

`can_*` permission flags (like `can_search`, `can_clean` above) are no longer set in YAML — grant them to a
Dreamliner Role instead. See [Permissions](permissions.md).

## Emojis

The icons used on command response embed titles (success, error, neutral, warning, unchecked) and on log card
titles (`logging.emojis`) are **fixed bot-wide and not configurable** — every server sees the same set, and
the dashboard cannot change them. The `emojis`/`logging.emojis` keys are no longer
part of guild config; an uploaded YAML with either block simply has it ignored (they fail schema validation and
get repaired away). See `src/core/embeds.ts` (`DEFAULT_EMOJIS`) and `src/core/logging/emojis.ts` (`LOG_EMOJI`) if
you're maintaining a fork and want to change the defaults in code.

Embed **author** always shows **Dreamliner** with the bot avatar. The **title** shows the emoji plus command title (e.g. success emoji + `Configuration saved`).

## Response visibility

```yaml
ephemeral_responses: false
```

When `false` (default), command replies are **public** in the channel. Set to `true` to make all responses ephemeral (only visible to the user who ran the command).

## Admin bypass

```yaml
admin_bypass: true
```

When `true` (the default, no configuration required), anyone with Discord's **Administrator** permission — or the server owner — can use any bot command, regardless of Dreamliner Role assignment. This is what lets a freshly-invited bot work for admins immediately. Toggle it from the dashboard's server settings page, or set `admin_bypass: false` here to require explicit Dreamliner Role grants even for admins.

## Dreamliner Roles

Permissions are managed with **Dreamliner Roles** — named permission groups (built-in **Member**, **Moderator**, **Admin**, plus any custom roles you create), each with assigned Discord roles/users and a flat set of granted `can_*` flags. They live in the database, not in this YAML — there is no `levels` field and no `can_*` grant here anymore.

A member's effective permission for a flag is the **OR** of every Dreamliner Role they belong to.

Manage Dreamliner Roles from the dashboard's **Roles** page, or with `/permissions role ...` in Discord.

For a complete setup guide with examples, see [Permissions setup](permissions.md).

## Log channels

```yaml
server_log_channel_id: "1234567890123456789"
moderation_log_channel_id: "1234567890123456789"
logging:
  events:
    member_join: true
    voice_self_mute: false
```

| Channel / key               | Purpose                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `server_log_channel_id`     | Discord channel for server/guild audit events                                         |
| `moderation_log_channel_id` | Discord channel for infractions, automod, censor, clean, voice mod, case updates      |
| `logging.events`            | Per-event toggles (missing keys default to enabled). Configured in dashboard Logging. |

Events are also stored for the dashboard **Logs** page (90 days). The legacy `log_channel_id` still works as a fallback for moderation Discord posts. See [Logs plugin](plugins/logs.md).

## Plugin sections

Each plugin is configured under `plugins.<name>`:

| Field                     | Description                                                     |
| ------------------------- | --------------------------------------------------------------- |
| `enabled`                 | Set `false` to disable (utility is enabled when section exists) |
| `config`                  | Direct config values                                            |

`can_*` permission flags are never set here — grant them to a Dreamliner Role on the dashboard's **Roles** page, or with `/permissions role grant`. There is no more `overrides`/`replaceDefaultOverrides` field, and no more channel/category-scoped grants. See [Permissions](permissions.md).

## Merge behavior

Whatever you save on the dashboard is **deep-merged** with `config/default.server.yaml` — you only ever customize the fields you touch, and new Dreamliner defaults apply automatically to anything you haven't.

See also: [Autorole](plugins/autorole.md), [Member identity](plugins/member_identity.md), [Translation](plugins/translation.md), [Logs](plugins/logs.md), [Starboard](plugins/starboard.md).

## Config commands

| Command                 | Description                                                       |
| ------------------------ | ------------------------------------------------------------------ |
| `/config`               | Posts a link to open this server's dashboard                       |
| `/permissions role ...` | Manage Dreamliner Roles without leaving Discord                    |
| `/plugin toggle`        | Enable or disable a plugin (`plugin` + `state`: Enable / Disable)  |
| `/plugin list`          | Show which plugins are enabled or disabled                         |

### Workflow

1. Run `/config` (or open the dashboard link from the join message) and sign in with Discord.
2. Pick this server, edit plugins and fields (channels/roles/members have search autocomplete).
3. Click **Save** — Dreamliner applies the config immediately, no restart or re-upload needed.

A new server already has a working default config the moment Dreamliner joins, so every command works
immediately; the dashboard is only for customizing it. Machine-readable schema for the editor is generated with
`npm run schema:export` into `schema/guild-config.schema.json` (also run during `prebuild`).

## Reloading

Admins with `can_reload_guild` can run `/reload` to re-read the config from the database without re-uploading.

## Plugin index

Dreamliner is organized into plugins under the `plugins:` key. Each plugin has its own `config` and `enabled` flag.

| Category          | Plugins                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Moderation        | infractions, slowmode                                                                            |
| Protection        | automod, scam\_protect, persist, autodelete                                                      |
| Role management   | roles, autorole                                                                                   |
| Self-serve roles  | reaction\_roles, role\_buttons, self\_grantable\_roles                                           |
| Lookups           | locate\_user, name\_history, username\_saver                                                     |
| Engagement        | welcome\_message, companion\_channels, starboard                                                 |
| Auto responses    | tags, autoreplies, autoreactions, translation                                                       |
| Scheduling        | reminders, counters                                                                               |
| Customization     | dream\_commands                                                                                   |
| Utilities         | utility, stats, bot\_customisation, logs                                                         |
| Feedback          | reviews, suggestions                                                                             |

See [Documentation index](/broken/pages/ScBf0pRjbQl3XDFHSAMa) for setup guides per plugin. The dashboard exposes every configurable field for every plugin.
