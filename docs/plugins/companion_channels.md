# Companion channels plugin

Join-to-create temporary voice rooms. Pick hub channels in the dashboard, choose a setup type, and owners manage their rooms from an in-channel panel or `/companion` commands.

Inspired by [VoiceMaster](https://voicemaster.xyz/) join-to-create: default, sequential, predefined, clone, and dynamic rooms, plus lock, ghost, claim, permit, text channels, and the rest of the owner controls.

Setup is **dashboard only**. There is no `/companion create` hub command.

## Configuration

```yaml
plugins:
  companion_channels:
    enabled: true
    config:
      setups:
        - enabled: true
          name: Gaming
          hub_channel_id: "123"
          type: predefined
          name_template: "{user_display}'s {animals}"
          user_limit: 5
          bitrate: 0
          category_id: ""
          permission_source: category
          editable: true
          auto_text: false
          default_lock: false
          default_ghost: false
          default_nsfw: false
          default_status: ""
          region: ""
          dynamic_ready: 3
      features:
        name: true
        lock: true
        interface: true
        nsfw: false
      log_channel_id: ""
      lfm_channel_id: ""
      staff_role_id: ""
```

### Setup types

| Type | Behaviour |
|------|-----------|
| `default` | Named from the template. Owners can rename and set a limit if those features are on. |
| `sequential` | `{name_template} 1`, `2`, `3`… via `{seq}` |
| `predefined` | Template variables: `{user_display}`, `{username}`, `{seq}`, `{animals}`, `{colors}`, `{trees}` |
| `clone` | Copies the hub's name, user limit, bitrate, and region |
| `dynamic` | Keeps `dynamic_ready` empty rooms ahead of time. Joining the hub claims one. |

### Feature toggles

Owner controls you can allow or block server-wide: name, limit, status, lock, claim, reject, permit, ghost, lfm, text, bitrate, invite, transfer, nsfw, interface, interface ping, manage channel, move member, autotext, region.

Staff with `staff_role_id` can always manage any room.

## Commands

`/companion` works in a temporary room (or while you are in one):

| Command | Description |
|---------|-------------|
| `/companion name` | Rename |
| `/companion limit` | User limit (`0` = unlimited) |
| `/companion lock` / `unlock` | Block or allow new joins |
| `/companion ghost` / `unghost` | Hide or show in the channel list |
| `/companion claim` | Take ownership if the owner left |
| `/companion permit` / `reject` | Allow or block a user/role |
| `/companion transfer` | Give ownership to someone else |
| `/companion invite` | DM an invite |
| `/companion status` | Voice channel status |
| `/companion bitrate` | Audio quality |
| `/companion region` | Voice region |
| `/companion nsfw` | NSFW flag |
| `/companion text` | Linked private text channel |
| `/companion lfm` | Post in the Looking for Members channel |

## Requirements

- **Manage Channels**, **Move Members**, **Connect**, **Send Messages**. Status needs **Set Voice Channel Status**. Invites need **Create Instant Invite**.
- Empty rooms are deleted when the last person leaves. Dynamic rooms reset into the ready pool instead when possible.
- If someone already owns a room, joining a hub moves them back to it.
