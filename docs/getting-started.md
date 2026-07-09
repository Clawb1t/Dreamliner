# Getting started

Dreamliner uses a **download → edit → upload** workflow for server configuration. There is no in-Discord setup wizard or web dashboard.

## 1. Invite the bot

Invite Dreamliner to your server with the permissions listed in [Permissions setup](permissions.md#step-1-bot-invite-permissions).

At minimum you will need:

* Manage Server (for `/config` commands)
* Manage Messages (for `/clean`)
* Ban Members (for `/bansearch`)
* Move Members (for `/voice` commands)
* Manage Nicknames (for `/nickname`)

The bot also needs standard read/send message permissions in channels where commands are used.

## 2. Download the template

A server administrator runs:

```
/config template
```

This sends `dreamliner-template.yaml` - the default configuration maintained by the bot operator. It includes emoji settings, permission levels, and utility plugin defaults.

## 3. Edit the configuration

Open the YAML file in any text editor. Common first steps:

1. Set `levels` - map your mod/admin role or user IDs to numeric levels (e.g. `50` for mods, `100` for admins).
2. Adjust `emojis` if you want custom success/error/neutral/warning/unchecked prefixes.
3. Enable and configure plugins under `plugins` - see [plugin documentation](/broken/pages/ScBf0pRjbQl3XDFHSAMa#plugins) for categories:
   * **Core** - utility commands and infractions
   * **Moderation** - automod, censor, lockdown, persist, slowmode
   * **Roles** - role assignment, reaction roles, self-role panels
   * **Automation** - welcome messages, tags, scheduled posts, counters, and more
   * **Tracking** - name history, stats, locate user
   * **Customization** - custom events and command aliases
   * **Background** - autorole, starboard, and logs (no slash commands)
4. Tweak `plugins.utility` permissions and overrides.

See [Permissions setup](permissions.md) for a full walkthrough and examples. See [Configuration](configuration.md) for the full YAML format.

## 4. Upload your configuration

```
/config upload file:<your-edited.yaml>
```

Dreamliner validates the file, merges it with defaults, saves it to the database, and applies it immediately.

Use `/config validate` to check a file without saving.

## 5. Download your current config

To edit an existing setup:

```
/config download
```

This returns the effective configuration currently stored for your server.

## 6. Use utility commands

Once a configuration is uploaded, moderators can use commands like `/search`, `/user`, `/clean`, and `/help`. Permission is controlled by your YAML config, not just Discord roles.

## Troubleshooting

| Problem                      | Solution                                                |
| ---------------------------- | ------------------------------------------------------- |
| "No configuration yet"       | Run `/config template` → edit → `/config upload`        |
| "You do not have permission" | See [Permissions setup](permissions.md#troubleshooting) |
| Upload validation errors     | Run `/config validate` to see specific field errors     |
| Commands not appearing       | Ask the bot operator to run `pnpm register-commands`    |
