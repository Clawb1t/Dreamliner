# Configuration

Dreamliner server configuration is written in YAML. Each server has its own config stored in the database after upload.

## File format

```yaml
emojis:
  success: "<:blurplecheck:1533947878668763278>"
  error: "<:redcheck:1533947951481749504>"
  neutral: "<:greycheck:1533948078615298148>"
  warning: "<:warning:1533948583995244734>"
  unchecked: "<:greycheck:1533948078615298148>"

levels:
  "ROLE_OR_USER_SNOWFLAKE": 100   # Admin
  "ROLE_OR_USER_SNOWFLAKE": 50    # Mod

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
    overrides:
      - level: ">=50"
        config:
          can_search: true
          can_clean: true
```

## Emojis

The `emojis` block sets the icons used on command response embed titles:

```yaml
emojis:
  success: "<:blurplecheck:1533947878668763278>"
  error: "<:redcheck:1533947951481749504>"
  neutral: "<:greycheck:1533948078615298148>"
  warning: "<:warning:1533948583995244734>"
  unchecked: "<:greycheck:1533948078615298148>"
```

* **success** - positive outcomes (saved, updated, reloaded, etc.)
* **error** - permission denied, invalid input, not found, etc.
* **neutral** - general information and commands
* **warning** - soft failures and advisories (not configured, already exists, etc.)
* **unchecked** - disabled or off states

Embed **author** always shows **Dreamliner** with the bot avatar. The **title** shows the emoji plus command title (e.g. success emoji + `Configuration saved`).

Custom Discord emojis use the `<:name:id>` form and must be available to the bot.

## Response visibility

```yaml
ephemeral_responses: false
```

When `false` (default), command replies are **public** in the channel. Set to `true` to make all responses ephemeral (only visible to the user who ran the command).

## Admin bypass

```yaml
admin_bypass: true
```

When `true` (the default, no configuration required), anyone with Discord's **Administrator** permission — or the server owner — can use any bot command, regardless of `levels`/`can_*` overrides. This is what lets a freshly-invited bot work for admins immediately. Toggle it from the dashboard's server settings page, or set `admin_bypass: false` here to require explicit `levels`/overrides even for admins.

## Permission levels

The template ships with an empty map: `levels: {}`.

Replace that with indented role/user ID entries (do **not** keep the `{}` braces when adding IDs):

```yaml
levels:
  "ROLE_OR_USER_SNOWFLAKE": 100   # Admin
  "ROLE_OR_USER_SNOWFLAKE": 50    # Mod
```

A member's level is the **highest** level from their roles and their user ID. Overrides use level syntax like `">=50"` to grant plugin permissions to mods without listing every user.

Server owners and anyone with Discord's own **Administrator** or **Manage Server** permission always reach level **100** (the built-in admin tier), even with an empty `levels: {}` map — so a freshly-invited bot isn't locked out of every command before you've mapped any roles.

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
| `overrides`               | Context-specific overrides                                      |
| `replaceDefaultOverrides` | If `true`, ignore built-in default overrides                    |

### Override criteria

| Key        | Matches                                 |
| ---------- | --------------------------------------- |
| `level`    | Member level (`">=50"`, `">100"`, etc.) |
| `channel`  | Specific channel ID                     |
| `category` | Category channel ID                     |
| `user`     | Specific user ID                        |
| `role`     | Members who have this role ID           |

For everyday grants (user / role / everyone) and level assignment, prefer `/permissions` instead of editing YAML. See [Permissions](permissions.md).

## Merge behavior

On upload, your YAML is **deep-merged** with `config/default.server.yaml`. You only need to include keys you want to change.

See also: [Autorole](plugins/autorole.md), [Member identity](plugins/member_identity.md), [Translation](plugins/translation.md), [Logs](plugins/logs.md), [Starboard](plugins/starboard.md).

## Config commands

| Command            | Description                                                     |
| ------------------ | --------------------------------------------------------------- |
| `/config template` | Default template from bot operator                              |
| `/config download` | Current effective config for this server                        |
| `/config upload`   | Validate and save a config file                                 |
| `/config validate` | Dry-run validation                                              |
| `/config update`   | Apply new Dreamliner defaults while keeping your customizations |
| `/permissions ...` | Grant commands / set levels without re-uploading YAML           |
| `/plugin toggle`   | Enable or disable a plugin (`plugin` + `state`: Enable / Disable) |
| `/plugin list`     | Show which plugins are enabled or disabled                      |

### Workflow

1. Run `/config template` (new server) or `/config download` (existing server).
2. Edit the YAML file locally, or use the website **config editor** (loads the schema from this repo).
3. Run `/config validate` to check for errors (optional).
4. Run `/config upload` to apply.

Machine-readable schema for the editor is generated with `npm run schema:export` into `schema/guild-config.schema.json` (also run during `prebuild`).

### `/config update`

When Dreamliner ships new default settings, run `/config update` to pick up changes you did not customize. Your overrides are preserved using the raw YAML from your last upload.

If your config was saved before this feature existed, the bot uses diff detection against the stored defaults snapshot. Re-uploading via `/config upload` improves future updates.

## Reloading

Admins with `can_reload_guild` can run `/reload` to re-read the config from the database without re-uploading.

## Plugin index

Dreamliner is organized into plugins under the `plugins:` key. Each plugin has its own `config`, optional `overrides`, and `enabled` flag.

| Category          | Plugins                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Moderation        | infractions, admin, slowmode                                                                     |
| Protection        | automod, scam\_protect, persist, autodelete                                                      |
| Role management   | roles, role\_manager, autorole, pingable\_roles                                                  |
| Self-serve roles  | reaction\_roles, role\_buttons, self\_grantable\_roles                                           |
| Lookups           | locate\_user, name\_history, username\_saver                                                     |
| Engagement        | welcome\_message, companion\_channels, starboard                                                 |
| Auto responses    | tags, autoreplies, autoreactions, translation                                                       |
| Scheduling        | post, reminders, counters                                                                        |
| Customization     | custom\_events, command\_aliases, dream\_commands                                                |
| Utilities         | utility, stats, bot\_customisation, logs                                                         |
| Feedback          | reviews, suggestions                                                                             |

See [Documentation index](/broken/pages/ScBf0pRjbQl3XDFHSAMa) for setup guides per plugin. The default template (`/config template`) includes all configurable fields.
