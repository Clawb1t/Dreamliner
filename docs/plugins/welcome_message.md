# Welcomer plugin

Send configurable **join**, **leave**, and **DM** welcomes with plain text, Discord embeds, and generated image cards. Setup is dashboard-first.

## Configuration

```yaml
plugins:
  welcome_message:
    enabled: true
    config:
      join:
        enabled: true
        channel_id: "1234567890123456789"
        content: "Welcome {user} to **{guild}**!"
        embed:
          enabled: false
        card:
          enabled: false
      leave:
        enabled: false
        content: ""
        embed:
          enabled: false
        card:
          enabled: false
      dm:
        enabled: false
        content: ""
        embed:
          enabled: false
        card:
          enabled: false
      first_message_react:
        enabled: false
        emoji: ""
      delete_join_on_early_leave: false
      wave_button:
        enabled: false
        label: "Wave"
        emoji: "👋"
```

Grant `can_set`, `can_test`, and `can_disable` to a Dreamliner Role on the dashboard's **Roles** page (or
`/permissions role grant`) — see [permissions.md](../permissions.md).

| Section | Description |
|---------|-------------|
| `join` | Channel message when a member joins |
| `leave` | Channel message when a member leaves |
| `dm` | Private message when a member joins |
| `first_message_react` | React to a new member's first chat message |
| `delete_join_on_early_leave` | Delete the join welcome if they leave within 24 hours |
| `wave_button` | Add a Wave button on join welcomes with a unique-user tally |

Each event supports:

- `content`: optional message text
- `embed`: title, description, color, thumbnail/image URL, footer, timestamp, fields
- `card`: generated image attached as a standalone file (not inside the embed)

Legacy configs with top-level `channel_id` + `message` are migrated automatically into `join`.

## Placeholders

| Token | Meaning |
|-------|---------|
| `{user}` | Mention |
| `{user_name}` / `{username}` | Username |
| `{user_display}` | Display name |
| `{guild}` / `{server}` | Server name |
| `{guild_member_count}` / `{member_count}` / `{memberCount}` | Member count |
| `{avatar_url}` | Member avatar URL |
| `{guild_icon_url}` | Server icon URL |

## Image cards

Cards are PNG images rendered with `@napi-rs/canvas` and attached as files next to the message:

- Background: solid color, remote URL, or dashboard upload (`background_asset_id`)
- Avatar layouts: `left`, `center`, `right`
- Text layouts: `beside`, `below`, `overlay_center`, `overlay_bottom`
- Fine controls: border color/width/radius, avatar size and offsets, text offsets, font sizes, accent bar toggle

## Member milestones

`member_milestones` celebrates member counts like 1,000 or 10,000. It has a default `channel_id` and a default
message (`content` / `embed` / `card`), plus a `milestones` list (up to 50):

```yaml
member_milestones:
  enabled: true
  channel_id: "123456789012345678"
  content: "🎉 We just hit **{milestone} members**! Welcome {user}, you're member #{milestone}."
  milestones:
    - count: 1000
    - count: 10000
      name: "Ten thousand"
      channel_id: "234567890123456789"   # optional per-milestone channel
      message_mode: custom                # post this milestone's own message instead
      message:
        content: "🚀 {milestone_name}! Thank you all."
```

- A milestone fires when a join brings the member count **exactly** onto it, so adding a count the
  server has already passed never triggers a stale celebration.
- Each count is celebrated once, ever. Dropping below it and climbing back doesn't repeat it.
- Bots count too, matching Discord's member count and `{member_count}`.
- Extra placeholders: `{milestone}` (e.g. `1,000`) and `{milestone_name}` (the label, or `1,000 members`).
  `{user}` is the member whose join hit the milestone.

## First message emoji

When `first_message_react.enabled` is true and `emoji` is set (server emoji id or unicode), Dreamliner reacts to that member's first message after joining (within 7 days).

## Commands

| Command | Description |
|---------|-------------|
| `/welcome set` | Set the join channel |
| `/welcome show` | Summary of current settings |
| `/welcome test` | Send a test join/leave/DM message |
| `/welcome disable` | Disable join welcomes |

The dashboard also has a **Test** button that posts the active tab's message using your member as the sample user.
