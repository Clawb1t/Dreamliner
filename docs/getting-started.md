# Getting started

Dreamliner is configured entirely from the **web dashboard** — there is no download/upload YAML workflow. You can
also manage Dreamliner Roles and command access in Discord with `/permissions role ...` without ever opening the
dashboard.

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

As soon as Dreamliner joins, it provisions a working default config for the server — every command works
immediately, before anyone touches the dashboard.

## 2. Open the dashboard

A server administrator runs:

```
/config
```

This posts a link to this server's dashboard. Open it and sign in with Discord — this server is already selected.

## 3. Configure

1. Set up Dreamliner Roles - assign your mod/admin Discord roles or users to the built-in **Moderator**/**Admin** roles (dashboard **Roles** page, or `/permissions role assign`).
2. Enable and configure plugins - see [plugin documentation](/broken/pages/ScBf0pRjbQl3XDFHSAMa#plugins) for categories:
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
3. Grant `plugins.utility`'s `can_*` permissions to your Dreamliner Roles.
4. Click **Save**. Dreamliner applies the config immediately - no restart, no re-upload.

See [Permissions setup](permissions.md) for a full walkthrough and examples. See [Configuration](configuration.md) for the underlying config format.

## 4. Use utility commands

Moderators can use commands like `/search`, `/user`, `/clean`, and `/help` right away. Permission is controlled by Dreamliner Roles, not just Discord roles.

## Troubleshooting

| Problem                      | Solution                                                |
| ----------------------------- | ------------------------------------------------------- |
| "You do not have permission" | See [Permissions setup](permissions.md#troubleshooting) |
| Commands not appearing       | Ask the bot operator to run `pnpm register-commands`    |
