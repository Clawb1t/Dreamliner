# Permissions setup

Dreamliner uses **two separate permission systems**. Both must be configured for commands to work as expected.

1. **Discord permissions** - what the bot and the user can do in Discord itself (invite scopes, role permissions).
2. **Dreamliner Roles** - named permission groups you define per-server, each granting a flat set of `can_*` flags.

A member needs **both** where applicable. For example, `/clean` requires `can_clean: true` from a Dreamliner Role the member belongs to **and** the **Manage Messages** Discord permission on the member's roles.

***

## Step 1: Bot invite permissions

When inviting Dreamliner, grant at least these **bot permissions**:

| Permission           | Why                                                       |
| --------------------- | --------------------------------------------------------- |
| View Channels          | See channels and run commands                             |
| Send Messages          | Reply to slash commands                                   |
| Embed Links            | Link previews in some outputs                              |
| Attach Files           | `/source`, `/avatar`                                       |
| Read Message History   | `/message`, `/context`, `/clean`, `/source`                |
| Manage Messages        | `/clean` bulk delete                                        |
| Ban Members            | `/bansearch`, `/ban`, `/unban`, `/softban`                  |
| Kick Members           | `/kick`                                                     |
| Moderate Members       | `/mute`, `/unmute`                                          |
| Move Members           | `/voice move`, `/voice move-all`, `/voice disconnect`       |
| Manage Nicknames       | `/nickname` on other members                                 |
| Manage Expressions     | `/stealemoji` (bot needs this too)                           |
| Manage Webhooks        | Message link expand and auto-translate author avatars        |
| Manage Channels        | Scam Protect honeypot channel create / position               |
| Manage Server          | `/config` and `/permissions` (checked on the **user**, not the bot) |

**Recommended:** use the `applications.commands` scope so slash commands appear.

The bot does **not** need Administrator. Grant only what you use.

### Channel overwrites

If commands fail in specific channels, check channel permission overwrites for the bot role. The bot needs **View Channel**, **Send Messages**, and **Use Application Commands** in every channel where commands are used.

***

## Step 2: Open the dashboard

A default config is provisioned automatically the moment Dreamliner joins, so every command already works. To
customize it:

1. Run `/config` (requires Discord **Manage Server**) for a link to this server's dashboard.
2. Sign in with Discord, edit plugins/fields, then **Save** — it applies immediately.

***

## Step 3: Set up Dreamliner Roles

Dreamliner Roles are named permission groups, similar to Discord's own roles: each has a name, a list of assigned Discord roles/users (its **members**), and a flat set of granted `can_*` permissions. They live in the database, not in your config YAML.

Every server starts with three built-in roles:

| Role | Assigned by default | Notes |
| ---- | -------------------- | ----- |
| **Member**    | Everyone in the server | Applies to all members automatically; can't be assigned/unassigned targets, renamed, or deleted. |
| **Moderator** | Nobody                 | Assign your mod role(s)/users to it. |
| **Admin**     | Nobody                 | Assign your admin role(s)/users to it. |

Moderator and Admin ship with **zero assigned targets** — a server admin must assign their own Discord roles/users into them before anyone gets access through them. You can also create your own custom roles (e.g. "Support", "Trial Mod") with any name and permission set.

A member's effective permission for a given `can_*` flag is the **OR** across every Dreamliner Role they belong to: if they're in the Member role (always) plus any others (via a directly-assigned user, or a Discord role that's assigned), they have the flag if **any one** of those roles grants it. There is no more channel/category-scoped permission grant, and no more numeric levels anywhere.

Server owners and anyone with Discord's own **Administrator** or **Manage Server** permission always pass every permission check, regardless of Dreamliner Role assignment. This is controlled by `admin_bypass` (default `true`; see [Configuration](configuration.md#admin-bypass)) and is toggleable from the dashboard's server settings page if you'd rather admins go through configured Dreamliner Roles too.

### Managing Dreamliner Roles

**Dashboard (primary):** open the guild dashboard's **Roles** page. Pick a role to see and edit its assigned Discord roles/users, and toggle its permissions in a grouped grid — like Discord's own role-permissions page.

**Discord (secondary):** `/permissions role ...` (requires Discord **Manage Server**):

```
/permissions role create name:<string>
/permissions role delete name:<dreamliner-role>
/permissions role rename name:<dreamliner-role> new_name:<string>
/permissions role assign role:<dreamliner-role> discord_role:<role>
/permissions role assign role:<dreamliner-role> discord_user:<user>
/permissions role unassign role:<dreamliner-role> discord_role:<role>
/permissions role unassign role:<dreamliner-role> discord_user:<user>
/permissions role grant role:<dreamliner-role> command:<command> allow:<bool>
/permissions role list
/permissions role view role:<dreamliner-role>
```

`role` and `command` options support autocomplete.

Example — grant your Moderator role `/clean` and `/search`:

```
/permissions role grant role:Moderator command:clean allow:true
/permissions role grant role:Moderator command:search allow:true
```

***

## Step 4: Understand `can_*` flags

Each utility command is gated by a boolean flag, for example `can_search`, `can_clean`, `can_userinfo`. A member has a flag only if **at least one** Dreamliner Role they belong to grants it.

See [Utility plugin](plugins/utility.md) for the full flag → command mapping.

Infraction commands use flags such as `can_warn`, `can_ban`, `can_view`. See [Infractions plugin](plugins/infraction.md).

Every other plugin uses the same pattern: its own set of `can_*` flags, granted per Dreamliner Role on the dashboard's **Roles** page or via `/permissions role grant`. See the [plugin index](/broken/pages/ScBf0pRjbQl3XDFHSAMa) for each plugin's permission flags.

`can_*` values written inside a plugin's `config:` block in an uploaded/downloaded YAML are **vestigial and ignored** — permission grants only ever come from Dreamliner Roles now, never from YAML.

***

## Step 5: Example setups

### Basic mod / admin setup

On the dashboard **Roles** page:

1. Open **Moderator**, assign your `@Moderator` Discord role, then grant search/clean/info/nicknames/voice/help-tier flags (`can_search`, `can_clean`, `can_userinfo`, `can_help`, ...).
2. Open **Admin**, assign your `@Admin` Discord role, then grant everything Moderator has plus meta/admin flags (`can_reload_guild`, `can_ping`, `can_about`, ...).

The same setup with `/permissions role`:

```
/permissions role assign role:Moderator discord_role:@Moderator
/permissions role grant role:Moderator command:search allow:true
/permissions role grant role:Moderator command:clean allow:true
/permissions role grant role:Moderator command:user allow:true
/permissions role grant role:Moderator command:help allow:true

/permissions role assign role:Admin discord_role:@Admin
/permissions role grant role:Admin command:reload allow:true
/permissions role grant role:Admin command:ping allow:true
/permissions role grant role:Admin command:about allow:true
```

### Grant a command to everyone

Grant the flag on the built-in **Member** role — it applies to every member of the server:

```
/permissions role grant role:Member command:help allow:true
/permissions role grant role:Member command:user allow:true
```

### Per-user access

Create a custom role and assign the specific user directly (no Discord role needed):

```
/permissions role create name:Trusted
/permissions role assign role:Trusted discord_user:@SomeUser
/permissions role grant role:Trusted command:source allow:true
/permissions role grant role:Trusted command:context allow:true
```

There's no more per-channel or per-category permission grant — a `can_*` flag is on or off for a member everywhere. Use a plugin's own settings (where it has channel-scoped options) for channel-specific behavior instead.

***

## Step 6: Discord permissions per command

Even with `can_*` enabled, some commands check the **member's** Discord permissions:

| Command                                               | Required Discord permission (on the user) |
| ------------------------------------------------------ | -------------------------------------------- |
| `/clean`                                                | Manage Messages                              |
| `/bansearch`                                            | Ban Members                                  |
| `/voice move`, `/voice move-all`, `/voice disconnect`   | Move Members                                  |
| `/nickname set`, `/nickname reset` (on others)          | Manage Nicknames                              |
| `/stealemoji`                                           | Manage Expressions                            |
| `/config`                                               | Manage Server                                 |

Voice, moderation, and nickname commands also use Discord's own **role hierarchy**: a moderator cannot act on a member whose highest Discord role is equal to or above their own, unless the moderator is the server owner. This applies to `/ban`, `/kick`, `/mute`, etc., and to `/voice move` / `/voice disconnect`.

***

## Step 7: Who can change permissions

| Action                                                                 | Requirement                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Edit server config on the dashboard                                     | Discord **Manage Server**                                                          |
| Create/rename/delete Dreamliner Roles, assign targets, grant commands   | Discord **Manage Server** (dashboard **Roles** page or `/permissions role ...`)      |
| Hot-reload config (`/reload`)                                            | `can_reload_guild` granted via a Dreamliner Role the member belongs to               |

### In-Discord permission editor

Use `/permissions role ...` (requires **Manage Server**) instead of the dashboard for quick changes:

| Command | What it does |
| ------- | ------------- |
| `/permissions role create name:<name>` | Create a new custom Dreamliner Role |
| `/permissions role delete name:<role>` | Delete a custom role (built-ins can't be deleted) |
| `/permissions role rename name:<role> new_name:<name>` | Rename a custom role |
| `/permissions role assign role:<role> discord_role:<role>` | Add a Discord role's members to a Dreamliner Role |
| `/permissions role assign role:<role> discord_user:<user>` | Add a specific user to a Dreamliner Role |
| `/permissions role unassign role:<role> discord_role:<role>` | Remove a Discord role from a Dreamliner Role |
| `/permissions role unassign role:<role> discord_user:<user>` | Remove a specific user from a Dreamliner Role |
| `/permissions role grant role:<role> command:<command> allow:<bool>` | Turn a command's permission on/off for a Dreamliner Role |
| `/permissions role list` | List all Dreamliner Roles on this server |
| `/permissions role view role:<role>` | Show a role's assigned targets and granted permissions |

`role` and `command` options support autocomplete. Changes are saved immediately (same store the dashboard's Roles page uses).

The dashboard still covers everything else in the config, but `can_*` grants are not among them anymore — always use Dreamliner Roles for those.

***

## Troubleshooting

| Symptom                               | Likely cause                                                | Fix                                                                          |
| --------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| "You do not have permission"          | No Dreamliner Role the member belongs to grants that flag     | Assign them to a role that has it, or grant it on their existing role         |
| "You need Manage Server"              | User lacks Discord perm                                        | Grant Manage Server or have an admin configure it on the dashboard            |
| "You need Manage Messages"            | `can_clean` ok but Discord perm missing                        | Add Manage Messages to mod role                                               |
| Command works for admins but not mods | Mod's Discord role/user isn't assigned to a Dreamliner Role with that flag | Assign it on the dashboard **Roles** page or `/permissions role assign` + `role grant` |
| Bot does not respond in a channel     | Channel overwrite                                              | Allow bot View Channel + Send Messages                                        |
| Changes after upload have no effect   | Old config cached                                               | `/reload` or re-upload                                                        |

### Verify a member's Dreamliner Role membership

`/permissions role view role:<name>` shows a Dreamliner Role's assigned Discord roles and users.

A member with `can_level` granted can also run:

```
/level member:@Someone
```

`/user` and `/level` on a member now list which Dreamliner Roles they belong to, instead of a numeric level.

***

## Related docs

* [Getting started](getting-started.md) - first-time setup flow
* [Configuration](configuration.md) - full YAML format
* [Utility plugin](plugins/utility.md) - every `can_*` flag and command
* [Infractions plugin](plugins/infraction.md) - moderation commands and case management
