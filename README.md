# ✈️ Dreamliner

**A Discord moderation & server-management bot** — YAML config, slash commands, no dashboard required.

Inspired by [Zeppelin](https://github.com/ZeppelinBot/Zeppelin). Configure your server by downloading a template, editing it, and uploading it back.

---

## 🚀 Invite

[**➕ Add Dreamliner to your server**](https://discord.com/oauth2/authorize?client_id=1524053555114151946&permissions=1099932494934&scope=bot%20applications.commands)

> Recommended permissions are pre-selected. See [Permissions setup](docs/permissions.md) for what each one is for — Dreamliner does **not** need Administrator.

---

## ⚡ Quick start

1. **Invite** Dreamliner with the link above  
2. Run **`/config template`** (needs **Manage Server**)  
3. Edit the YAML — set `levels`, channels, and plugins  
4. Run **`/config upload`** with your file  
5. You’re live — use **`/help`** anytime  

Full walkthrough: [Getting started](docs/getting-started.md)

---

## ✨ Features

### 🧰 Core
| Plugin | What it does |
|--------|----------------|
| **Utility** | Search, user/server/channel info, clean, voice tools, avatar, jumbo, help, and more |
| **Infractions** | Warn, note, mute, kick, ban, softban, case management, DMs, expirations |

### 🛡️ Moderation
| Plugin | What it does |
|--------|----------------|
| **Automod** | Duplicate messages, rate limits, raid detection |
| **Censor** | Word/phrase filters with configurable actions |
| **Admin** | Channel lockdown & unlock |
| **Persist** | Sticky messages that stay at the bottom of a channel |
| **Slowmode** | Per-channel slowmode control |

### 🎭 Roles
| Plugin | What it does |
|--------|----------------|
| **Roles** | Give / remove / list roles |
| **Reaction roles** | React to a message to claim a role |
| **Role buttons** | Button-based role assignment |
| **Self grantable roles** | Self-serve role panels |
| **Pingable roles** | Temporarily make roles mentionable |
| **Role manager** | Role templates for quick creation |
| **Autorole** | Auto-assign roles on join |

### 🤖 Automation
| Plugin | What it does |
|--------|----------------|
| **Welcome message** | Custom join messages |
| **Tags** | Reusable text snippets |
| **Scheduled posts** | Timed / recurring channel posts |
| **Autodelete** | Auto-clear messages after a delay |
| **Autoreactions** | React automatically to matching messages |
| **Reminders** | Personal reminders |
| **Counters** | Live member / message / custom counters |
| **Companion channels** | Personal voice channels from a hub |

### 📊 Tracking
| Plugin | What it does |
|--------|----------------|
| **Name history** | Track nickname / username changes |
| **Username saver** | Persist username history |
| **Locate user** | Find where a member is (voice, etc.) |
| **Stats** | Server, user, and channel stats |

### 🎨 Customization & extras
| Plugin | What it does |
|--------|----------------|
| **Custom events** | Hook actions to Discord events |
| **Command aliases** | Shortcuts and message triggers |
| **Starboard** | Highlight highly reacted messages |
| **Logs** | Server & moderation event logging |

Plus **per-server emoji prefixes** (success, error, neutral, warning, unchecked) and **level-based permissions** with `can_*` overrides.

---

## 📚 Documentation

| Guide | Description |
|-------|-------------|
| [📖 Docs home](docs/index.md) | Full documentation index |
| [🚦 Getting started](docs/getting-started.md) | Invite → template → upload |
| [⚙️ Configuration](docs/configuration.md) | YAML format, emojis, logs, plugins |
| [🔐 Permissions](docs/permissions.md) | Bot perms, levels, and `can_*` flags |

### Plugin docs

<details>
<summary><strong>Core</strong></summary>

- [Utility](docs/plugins/utility.md)
- [Infractions](docs/plugins/infraction.md)

</details>

<details>
<summary><strong>Moderation</strong></summary>

- [Automod](docs/plugins/automod.md)
- [Censor](docs/plugins/censor.md)
- [Admin](docs/plugins/admin.md)
- [Persist](docs/plugins/persist.md)
- [Slowmode](docs/plugins/slowmode.md)

</details>

<details>
<summary><strong>Roles</strong></summary>

- [Roles](docs/plugins/roles.md)
- [Reaction roles](docs/plugins/reaction_roles.md)
- [Role buttons](docs/plugins/role_buttons.md)
- [Self grantable roles](docs/plugins/self_grantable_roles.md)
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
- [Reminders](docs/plugins/reminders.md)
- [Counters](docs/plugins/counters.md)
- [Companion channels](docs/plugins/companion_channels.md)

</details>

<details>
<summary><strong>Tracking & customization</strong></summary>

- [Name history](docs/plugins/name_history.md)
- [Username saver](docs/plugins/username_saver.md)
- [Locate user](docs/plugins/locate_user.md)
- [Stats](docs/plugins/stats.md)
- [Custom events](docs/plugins/custom_events.md)
- [Command aliases](docs/plugins/command_aliases.md)
- [Starboard](docs/plugins/starboard.md)
- [Logs](docs/plugins/logs.md)

</details>

---

## 💡 Why Dreamliner?

- 📁 **File-based config** — download, edit, upload; your YAML is the source of truth  
- 🔒 **Fine-grained access** — levels + per-command `can_*` flags  
- ✂️ **Slash-only** — clean Discord UX, no prefix spam  
- 🧩 **Plugin architecture** — enable only what your server needs  

---

## 📜 License

MIT
