# Permissions setup

Dreamliner uses **two separate permission systems**. Both must be configured for commands to work as expected.

1. **Discord permissions** - what the bot and the user can do in Discord itself (invite scopes, role permissions).
2. **Dreamliner config permissions** - what each member can run via your uploaded YAML (`levels`, `can_*` flags, overrides).

A member needs **both** where applicable. For example, `/clean` requires `can_clean: true` in your config **and** the **Manage Messages** Discord permission on the member's roles.

***

## Step 1: Bot invite permissions

When inviting Dreamliner, grant at least these **bot permissions**:

| Permission           | Why                                                       |
| -------------------- | --------------------------------------------------------- |
| View Channels        | See channels and run commands                             |
| Send Messages        | Reply to slash commands                                   |
| Embed Links          | Link previews in some outputs                             |
| Attach Files         | `/config download`, `/source`, `/avatar`                  |
| Read Message History | `/message`, `/context`, `/clean`, `/source`               |
| Manage Messages      | `/clean` bulk delete                                      |
| Ban Members          | `/bansearch`, `/ban`, `/unban`, `/softban`                |
| Kick Members         | `/kick`                                                   |
| Moderate Members     | `/mute`, `/unmute`                                        |
| Move Members         | `/voice move`, `/voice move-all`, `/voice disconnect`     |
| Manage Nicknames     | `/nickname` on other members                              |
| Manage Server        | `/config` commands (checked on the **user**, not the bot) |

**Recommended:** use the `applications.commands` scope so slash commands appear.

The bot does **not** need Administrator. Grant only what you use.

### Channel overwrites

If commands fail in specific channels, check channel permission overwrites for the bot role. The bot needs **View Channel**, **Send Messages**, and **Use Application Commands** in every channel where commands are used.

***

## Step 2: Upload a server configuration

Utility commands are disabled until a server admin uploads a config:

1. `/config template`
2. Edit the YAML file
3. `/config upload`

Only members with Discord **Manage Server** can use `/config` commands.

***

## Step 3: Assign permission levels

Dreamliner permission levels are defined in the `levels` section of your YAML. Map **role IDs** or **user IDs** to numbers. Higher numbers mean more access.

The template starts with an empty map:

```yaml
levels: {}
```

Replace that with indented entries (do **not** keep the `{}` braces when adding IDs):

```yaml
levels:
  "1234567890123456789": 100   # @Admin role
  "9876543210987654321": 50    # @Moderator role
  "1111111111111111111": 75    # Specific trusted user
```

Quote every ID as a string so YAML does not alter large snowflakes. Comments after values are optional.

### How to get IDs

1. Enable **Developer Mode** in Discord (Settings → Advanced → Developer Mode).
2. Right-click a role or user → **Copy Role ID** / **Copy User ID**.

### How levels are calculated

A member's level is the **highest** value from:

* Their user ID entry in `levels`, and
* Every role they have that appears in `levels`.

If a member has no matching entries, their level is **0**.

***

## Step 4: Understand `can_*` flags

Each utility command is gated by a boolean flag in `plugins.utility.config`, for example `can_search`, `can_clean`, `can_userinfo`. These default to `false` unless granted by an override or explicit config.

See [Utility plugin](plugins/utility.md) for the full flag → command mapping.

Infraction commands use `plugins.infractions.config` flags such as `can_warn`, `can_ban`, `can_view`. See [Infractions plugin](plugins/infraction.md).

Every other plugin uses the same pattern: `can_*` flags under `plugins.<name>.config`, usually granted at level `>=50` via overrides. See the [plugin index](/broken/pages/ScBf0pRjbQl3XDFHSAMa) for each plugin's permission flags.

Dreamliner ships with **built-in default overrides** (merged with your config unless you set `replaceDefaultOverrides: true`):

| Level                | Utility flags                                     | Infraction flags                                   |
| -------------------- | ------------------------------------------------- | -------------------------------------------------- |
| `>=50` (mod tier)    | Search, clean, info, nicknames, voice, help, etc. | Warn, note, mute, kick, view, edit reason/duration |
| `>=100` (admin tier) | Above plus reload, ping, about                    | Above plus ban, unban, softban, delete             |

So with default overrides, a member at level **50+** can use most mod tools; level **100+** gets admin/meta tools.

***

## Step 5: Example configurations

### Basic mod / admin setup

```yaml
levels:
  "ADMIN_ROLE_ID": 100
  "MOD_ROLE_ID": 50

plugins:
  utility:
    overrides:
      - level: ">=50"
        config:
          can_search: true
          can_clean: true
          can_userinfo: true
          can_help: true
      - level: ">=100"
        config:
          can_reload_guild: true
          can_ping: true
          can_about: true
```

After editing, run `/config upload` or `/config validate` first.

### Grant a command to everyone

Set the flag directly under `config` (no level required):

```yaml
plugins:
  utility:
    config:
      can_help: true
      can_userinfo: true
```

### Restrict `/clean` to a single channel

```yaml
plugins:
  utility:
    overrides:
      - level: ">=50"
        config:
          can_search: true
          can_userinfo: true
      - level: ">=50"
        channel: "MOD_CHANNEL_ID"
        config:
          can_clean: true
```

Members need level 50+ **and** must run `/clean` in that channel.

### Disable clean for one category

```yaml
plugins:
  utility:
    overrides:
      - level: ">=50"
        config:
          can_clean: true
      - level: ">=50"
        category: "ANNOUNCEMENTS_CATEGORY_ID"
        config:
          can_clean: false
```

### Per-user access

```yaml
plugins:
  utility:
    overrides:
      - user: "TRUSTED_USER_ID"
        config:
          can_source: true
          can_context: true
```

***

## Step 6: Discord permissions per command

Even with `can_*` enabled, some commands check the **member's** Discord permissions:

| Command                                               | Required Discord permission (on the user) |
| ----------------------------------------------------- | ----------------------------------------- |
| `/clean`                                              | Manage Messages                           |
| `/bansearch`                                          | Ban Members                               |
| `/voice move`, `/voice move-all`, `/voice disconnect` | Move Members                              |
| `/nickname set`, `/nickname reset` (on others)        | Manage Nicknames                          |
| `/config`                                             | Manage Server                             |

Voice and nickname commands also use Dreamliner's **act-on** rules: you cannot target members at or above your level, and you cannot moderate the server owner unless you are the owner.

***

## Step 7: Who can change permissions

| Action                              | Requirement                                      |
| ----------------------------------- | ------------------------------------------------ |
| Upload / download / validate config | Discord **Manage Server**                        |
| Hot-reload config (`/reload`)       | `can_reload_guild` in YAML (default: level 100+) |
| Change `levels` or `can_*` flags    | Edit YAML and `/config upload`                   |

There is no in-Discord permission editor. All permission changes go through the YAML file.

***

## Override matching rules

Overrides are evaluated in order. Later matching overrides **merge on top** of earlier ones for the same keys.

An override matches when **all** of its criteria match:

| Criterion        | Matches when                                     |
| ---------------- | ------------------------------------------------ |
| `level: ">=50"`  | Member's computed level satisfies the comparison |
| `channel: "ID"`  | Command is run in that channel                   |
| `category: "ID"` | Command channel is under that category           |
| `user: "ID"`     | The member running the command is that user      |

If an override omits a criterion, that criterion is not checked.

***

## Troubleshooting

| Symptom                               | Likely cause                            | Fix                                                |
| ------------------------------------- | --------------------------------------- | -------------------------------------------------- |
| "No configuration yet"                | No YAML uploaded                        | `/config template` → edit → `/config upload`       |
| "You do not have permission"          | Missing `can_*` or level too low        | Add role to `levels`, adjust overrides             |
| "You need Manage Server"              | User lacks Discord perm                 | Grant Manage Server or have an admin upload config |
| "You need Manage Messages"            | `can_clean` ok but Discord perm missing | Add Manage Messages to mod role                    |
| Command works for admins but not mods | Role not in `levels` or level < 50      | Add mod role ID with value `50`                    |
| Bot does not respond in a channel     | Channel overwrite                       | Allow bot View Channel + Send Messages             |
| Changes after upload have no effect   | Old config cached                       | `/reload` or re-upload                             |

### Verify a member's level

A member with `can_level` (mods by default) can run:

```
/level member:@Someone
```

***

## Related docs

* [Getting started](getting-started.md) - first-time setup flow
* [Configuration](configuration.md) - full YAML format
* [Utility plugin](plugins/utility.md) - every `can_*` flag and command
* [Infractions plugin](plugins/infraction.md) - moderation commands and case management
