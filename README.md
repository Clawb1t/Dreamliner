# Dreamliner

Moderation and ops for large Discord communities: YAML config, staff permissions, logging, automod, and a web dashboard.

Dreamliner is a Discord moderation and server-operations bot built for communities that outgrow one-size-fits-all tools. It is designed for staff teams that need clear permission boundaries, auditable configuration, and features that stay reliable as membership and moderation load grow.

Configure your server with versionable YAML: download a template, edit channels, plugins, and access levels, then upload. Day-to-day work can also run through the web dashboard for live config, logs, stats, and custom commands, without giving up file-based control. Dreamliner does not require Administrator; invite with least privilege and grant only what your staff need.

Core capabilities include infractions and case management, automod and raid tooling, content filters, structured logging, role and onboarding systems, multilingual translation, activity stats, and Dreamcode for custom slash commands. Enable only the plugins your community uses so the bot stays focused and predictable for operators.

Built for serious Discord operations. Inspired by [Zeppelin](https://github.com/ZeppelinBot/Zeppelin).

**Website:** [dreamliner.site](https://www.dreamliner.site) · **Dashboard:** [dreamliner.site/dashboard](https://www.dreamliner.site/dashboard)

---

## Invite

[Add Dreamliner to your server](https://discord.com/oauth2/authorize?client_id=1524053555114151946&permissions=1099932494934&scope=bot%20applications.commands)

Recommended permissions are pre-selected. Dreamliner does **not** require Administrator. See [Permissions](docs/permissions.md) for the full breakdown.

---

## Why operators choose it

- **Config as source of truth:** Guild YAML is portable, reviewable, and easy to back up or hand off between staff.
- **Least privilege by design:** Level-based access plus per-command `can_*` overrides so senior mods, trial staff, and helpers stay in their lane.
- **Ops without noise:** Enable only the plugins your community needs; leave the rest off.
- **Slash-first management:** Staff workflows and custom Dreamcode commands stay in Discord’s command surface.
- **Dashboard when you want it:** Live config, logs, stats, and Dreamcode editing without abandoning file-based control.

---

## Quick start

1. Invite Dreamliner with the link above.
2. Run `/config template` (requires **Manage Server**).
3. Edit the YAML: channels, plugins, and permission levels (levels can also be adjusted later with `/permissions`).
4. Run `/config upload` with your file.
5. Use `/permissions` for incremental access changes and `/help` for command discovery.

Walkthrough: [Getting started](docs/getting-started.md)

---

## Capabilities

### Moderation and safety

| Area | Capabilities |
| --- | --- |
| **Infractions** | Warn, note, mute, kick, ban, softban, case history, DMs, expirations |
| **Automod** | Duplicate messages, rate limits, raid detection |
| **Censor** | Word and phrase filters with configurable actions |
| **Admin** | Channel lockdown and unlock |
| **Slowmode** | Per-channel slowmode control |
| **Logs** | Structured server and moderation event logging (Discord channels + dashboard retention) |

### Roles and onboarding

| Area | Capabilities |
| --- | --- |
| **Roles** | Give, remove, and list roles |
| **Reaction / button / self-serve roles** | Claim flows that fit large join volume |
| **Autorole** | Separate human and bot join assignment |
| **Pingable roles** | Temporary mentionability for announcements |
| **Role manager** | Templates for consistent role creation |
| **Welcome message** | Controlled join messaging |

### Automation and content

| Area | Capabilities |
| --- | --- |
| **Tags** | Reusable staff and helper responses |
| **Scheduled posts** | Timed and recurring channel posts |
| **Autodelete / autoreactions / autoreplies** | Channel hygiene and lightweight automation |
| **Translation** | On-demand and optional auto-translate for multilingual communities |
| **Counters** | Live member, message, and custom counters |
| **Companion channels** | Personal voice channels from a hub |
| **Reminders** | Personal staff reminders |
| **Custom events / command aliases** | Hook Discord events and short triggers |
| **Dreamcode** | Custom slash commands with a dedicated language and dashboard editor |

### Visibility and utility

| Area | Capabilities |
| --- | --- |
| **Stats** | Server, user, and channel analytics |
| **Name history / username saver** | Audit trail for identity changes |
| **Locate user** | Find members (including voice) |
| **Utility** | Search, info, clean, voice tools, avatar, jumbo, help |
| **Starboard** | Surface highly reacted messages |
| **Persist** | Sticky messages that stay at the bottom of a channel |

Per-server emoji prefixes and bot customisation (nickname / avatar) are supported for brand consistency across guilds.

---

## Documentation

| Guide | Description |
| --- | --- |
| [Documentation index](docs/README.md) | Full docs entry point |
| [Getting started](docs/getting-started.md) | Invite → template → upload |
| [Configuration](docs/configuration.md) | YAML structure, logging, plugins |
| [Permissions](docs/permissions.md) | Bot permissions, levels, and `can_*` flags |
| [Plugins](docs/plugins/README.md) | Per-plugin reference |
| [Dreamcode](docs/dreamcode/README.md) | Custom command language |
| [Terms of Service](docs/terms-of-service.md) | Usage terms |
| [Privacy Policy](docs/privacy-policy.md) | Data handling |

### Plugin reference

<details>
<summary><strong>Moderation</strong></summary>

- [Infractions](docs/plugins/infraction.md)
- [Automod](docs/plugins/automod.md)
- [Censor](docs/plugins/censor.md)
- [Admin](docs/plugins/admin.md)
- [Persist](docs/plugins/persist.md)
- [Slowmode](docs/plugins/slowmode.md)
- [Logs](docs/plugins/logs.md)

</details>

<details>
<summary><strong>Roles</strong></summary>

- [Roles](docs/plugins/roles.md)
- [Reaction roles](docs/plugins/reaction_roles.md)
- [Role buttons](docs/plugins/role_buttons.md)
- [Self-grantable roles](docs/plugins/self_grantable_roles.md)
- [Pingable roles](docs/plugins/pingable_roles.md)
- [Role manager](docs/plugins/role_manager.md)
- [Autorole](docs/plugins/autorole.md)

</details>

<details>
<summary><strong>Automation</strong></summary>

- [Welcome message](docs/plugins/welcome_message.md)
- [Tags](docs/plugins/tags.md)
- [Scheduled posts](docs/plugins/post.md)
- [Autodelete](docs/plugins/autodelete.md)
- [Autoreactions](docs/plugins/autoreactions.md)
- [Autoreplies](docs/plugins/autoreplies.md)
- [Reminders](docs/plugins/reminders.md)
- [Counters](docs/plugins/counters.md)
- [Companion channels](docs/plugins/companion_channels.md)
- [Translation](docs/plugins/translation.md)
- [Custom events](docs/plugins/custom_events.md)
- [Command aliases](docs/plugins/command_aliases.md)
- [Dreamcode commands](docs/plugins/dream_commands.md)

</details>

<details>
<summary><strong>Tracking and tools</strong></summary>

- [Utility](docs/plugins/utility.md)
- [Stats](docs/plugins/stats.md)
- [Name history](docs/plugins/name_history.md)
- [Username saver](docs/plugins/username_saver.md)
- [Locate user](docs/plugins/locate_user.md)
- [Starboard](docs/plugins/starboard.md)
- [Bot customisation](docs/plugins/bot_customisation.md)

</details>

---

## Legal

- [Terms of Service](docs/terms-of-service.md)
- [Privacy Policy](docs/privacy-policy.md)

## License

MIT
