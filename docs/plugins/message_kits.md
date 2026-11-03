# Message Kits plugin

Design messages on the dashboard, keep them in a library, send them to channels, schedule them, and
**edit every copy already sent** later in one click. A kit is either a classic message (text, up to 10
embeds, buttons and menus, files) or a Components V2 layout (containers, sections, galleries,
separators, files, buttons and menus).

Everything is free. The only limits are hard caps: 100 kits, 25 saved versions per kit, 25 schedules,
10 channels per send, and 60 uploads (8 MB each, 250 MB in total) per server.

There are no slash commands: **send it from the dashboard** (Message Kits page).

## What a kit can do

- **Send as Dreamliner, or as a custom identity** (a webhook with its own name and avatar). Webhooks are
  created by Dreamliner itself (application-owned), so their buttons and menus work too.
- **Buttons and menus** that open a link, add / remove / toggle roles, reply privately with another kit
  (rendered for the person who clicked, so `{user}` works), or open a form (up to 5 questions) whose
  answers are posted to a channel, optionally pinging a role.
- **Placeholders**: `{server}`, `{member_count}`, `{channel}`, `{date}`, `{time}`; replies with a kit
  also get `{user}`, `{username}` and `{user_display}`. Unknown placeholders stay as written.
- **Forums and media channels**: sending creates a post titled after the kit (or its thread name).
- **Sent copies**: every copy is tracked. After editing a kit, "Update" edits the copies in place. A copy
  that can't be turned into the new version by an edit (a V2 layout back into a classic message, or a
  switch between Dreamliner and a custom identity) is sent again in the same place and the old one deleted.
- **Schedules**: once, daily, weekly or monthly at a time in any time zone (daylight saving handled; a
  monthly day past the end of a month runs on its last day). A schedule can replace its previous copy.
  Five failures in a row turn it off and log why.
- **Version history** (newest 25), duplicate, archive, folders, test-send to your DMs, and import from a
  message link, Discohook / Embed Generator JSON or an exported kit. A message Dreamliner sent before
  can be linked to a kit so updates edit it.

Buttons always run the kit's **current** actions, so changing a kit changes what every sent copy's
buttons do straight away. Role buttons never give staff roles, roles managed by integrations, or
roles above Dreamliner's highest role, and each member can press them once every 3 seconds.

## Configuration

Dashboard-managed. The only settings:

```yaml
plugins:
  message_kits:
    enabled: true
    config:
      log_channel_id: "123456789012345678"  # optional log of sends, edits and deletes
      ping_on_form: true                     # ping a form's role on each submission
```

## Permissions

| Flag | Default role | Grants |
| --- | --- | --- |
| `can_manage` | Admin | Create, edit and delete kits |
| `can_send` | Moderator, Admin | Send, schedule and update kits |

The dashboard pages themselves need **Manage Server**, like every plugin page.

## Requirements

In the target channel Dreamliner needs **View Channel** and **Send Messages** (or **Send Messages in
Threads** / **Create Posts**), plus **Embed Links** for embeds, **Attach Files** for uploads, and
**Manage Webhooks** to send with a custom identity. Role actions need **Manage Roles** with
Dreamliner's role above the roles it gives. Linking an existing message needs **Read Message History**.
