# Counting plugin

Turn one or more channels into counting channels: members count up together, one number per message,
and the bot enforces the rules. Fully configured on the dashboard, no in-Discord setup command.

## Configuration

```yaml
plugins:
  counting:
    enabled: true
    config:
      channels:
        - id: 6a6b1e2e-6e9a-4c9a-9f9a-2e2b6a6b1e2e
          name: Main counting
          enabled: true
          channel_id: "123456789012345678"
          start_at: 1
          step: 1
          allow_math: false
          require_alternate_user: true
          cooldown_seconds: 0
          allow_bots: false
          allow_non_number_messages: false
          delete_wrong_messages: true
          reset_on_mistake: true
          reset_to: zero
          milestone_every: 100
          announce_milestones: true
          pin_milestones: false
          announce_new_record: true
          announce_failure: true
          success_reaction: "<:icons_Correct:1544417199798886530>"
          failure_reaction: "<:icons_Wrong:1544417460638457937>"
          milestone_reaction: "<:icons_tada:1544417975472492594>"
          failure_message: "{user} broke the count! {reason} Starting over from **{restart}**."
          milestone_message: "{user} just hit **{number}**!"
          record_message: "{user} broke the record! New highest count: **{number}**."
          ignored_roles: []
          allowed_roles: []
          use_webhook: false
          webhook_name: ""
          webhook_avatar_url: ""
```

Grant `can_reset` and `can_stats` to a Dreamliner Role on the dashboard's **Roles** page (or
`/permissions role grant`), see [permissions.md](../permissions.md). Managing counting channel
setups on the dashboard itself just needs Discord Manage Server, like every other plugin's config
page.

| Field | Description |
|-------|-------------|
| `channels` | List of counting channel setups (see below) |
| `channel_id` | The text channel members count in |
| `start_at` / `step` | The first number, and how much the count must go up by each time |
| `allow_math` | Accept arithmetic like `12+3` as long as it evaluates to the right number |
| `require_alternate_user` | Block the same member from counting twice in a row |
| `cooldown_seconds` | Minimum seconds between any two successful counts |
| `allow_bots` | Let bot accounts participate |
| `allow_non_number_messages` | Off (default): every message is judged, anything wrong breaks the count. On: only real counting attempts are judged, other chat is left alone |
| `delete_wrong_messages` | Delete messages that break the count |
| `reset_on_mistake` / `reset_to` | Whether a mistake resets the count, and whether it resets to zero or the last milestone |
| `milestone_every` | Celebrate every Nth count (0 disables) |
| `announce_milestones` / `pin_milestones` | Post `milestone_message` on a milestone, and optionally pin it |
| `announce_new_record` | Post `record_message` when the count climbs back past this channel's previous best after a reset |
| `announce_failure` | Post `failure_message` when someone breaks the count |
| `success_reaction` / `failure_reaction` / `milestone_reaction` | Custom emoji reactions (leave empty for none). Default to the bot's own app emojis |
| `failure_message` / `milestone_message` / `record_message` | Templates. Placeholders: `{user}`, `{reason}` (failure only, a plain-English explanation like "You can't count twice in a row!"), `{number}`, `{expected}`, `{restart}`, `{highest}`, plus the usual `{guild}`/`{channel}` |
| `ignored_roles` | Members with any of these roles can't count here. Their attempts are removed/ignored and never affect the count either way |
| `allowed_roles` | If set, only members with one of these roles can count. Everyone else is treated like `ignored_roles` |
| `use_webhook` / `webhook_name` / `webhook_avatar_url` | Post milestone/failure/record messages as a webhook with a custom name and avatar instead of the bot |

## Commands

| Command | Permission | Description |
|---------|------------|--------------|
| `/counting stats [channel]` | `can_stats` | Show a channel's current count and highest count |
| `/counting reset [channel]` | `can_reset` | Reset a channel's count back to its `start_at` |

## Requirements

- The bot needs **Manage Messages** in the channel to delete wrong messages, **Add Reactions** to react,
  and **Manage Webhooks** if `use_webhook` is on (falls back to a normal bot message otherwise).
- Live count state (current count, highest count, who counted last) is tracked per channel in the
  database, not in the YAML config. The config only holds settings.
- Milestone/failure/record announcements are posted as the bot's standard Components V2 container
  (matching every other command response), not plain text.
