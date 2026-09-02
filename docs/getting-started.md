# Getting started

Dreamliner uses a **download → edit → upload** workflow for server configuration. After the first upload, you can also manage Dreamliner Roles and command access in Discord with `/permissions role ...` (no re-upload needed).

## 1. Invite the bot

Invite Dreamliner to your server with the permissions listed in [Permissions setup](permissions.md#step-1-bot-invite-permissions).

At minimum you will need:

* Manage Server (for `/config` and `/permissions` commands)
* Manage Messages (for `/clean`)
* Ban Members (for `/bansearch`)
* Move Members (for `/voice` commands)
* Manage Nicknames (for `/nickname`)
* Manage Expressions (for `/stealemoji`)
* Manage Webhooks (for message link expand and auto-translate author avatars)
* Manage Channels (for Scam Protect honeypot creation)

The bot also needs standard read/send message permissions in channels where commands are used.

## 2. Download the template

A server administrator runs:

```
/config template
```

This sends `dreamliner-template.yaml` - the default configuration maintained by the bot operator. It includes emoji settings and utility plugin defaults.

## 3. Edit the configuration

Open the YAML file in any text editor. Common first steps:

1. Set up Dreamliner Roles - assign your mod/admin Discord roles or users to the built-in **Moderator**/**Admin** roles (dashboard **Roles** page, or `/permissions role assign`).
2. Adjust `emojis` if you want custom success/error/neutral/warning/unchecked prefixes.
3. Enable and configure plugins under `plugins` - see [plugin documentation](/broken/pages/ScBf0pRjbQl3XDFHSAMa#plugins) for categories:
   * **Moderation** - infractions, lockdown, slowmode
   * **Protection** - automod, scam protect, persist, autodelete
   * **Role management** - staff role assign, templates, autorole, pingables
   * **Self-serve roles** - reaction, button, and panel roles
   * **Lookups** - name history, locate user, username saver
   * **Engagement** - welcomes, companion channels, starboard
   * **Auto responses** - tags, autoreplies, autoreactions, translation
   * **Scheduling** - timed posts, reminders, counters
   * **Customization** - custom events, aliases, custom commands
   * **Utilities** - utility commands, stats, bot customisation, logs
   * **Feedback** - reviews and suggestions
4. Grant `plugins.utility`'s `can_*` permissions to your Dreamliner Roles.

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

Once a configuration is uploaded, moderators can use commands like `/search`, `/user`, `/clean`, and `/help`. Permission is controlled by Dreamliner Roles, not just Discord roles.

## Troubleshooting

| Problem                      | Solution                                                |
| ---------------------------- | ------------------------------------------------------- |
| "No configuration yet"       | Run `/config template` → edit → `/config upload`        |
| "You do not have permission" | See [Permissions setup](permissions.md#troubleshooting) |
| Upload validation errors     | Run `/config validate` to see specific field errors     |
| Commands not appearing       | Ask the bot operator to run `pnpm register-commands`    |
