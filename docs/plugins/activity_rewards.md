# Activity Rewards plugin

Reward members for being active: grant (or take away) roles and post an announcement when a member
reaches a message-count or voice-time milestone, e.g. a role at 100 messages, another at 1,000, and one
for 10 hours in voice.

## Configuration

Dashboard-managed. Set up milestones on the website's config editor, or let **Autopilot** (the
page header's Autopilot button, wizard id `activity_rewards_setup`) ask a few questions and build a
ladder of milestones, roles and the announcement for you. Re-running it adds to your milestones
rather than replacing them.

```yaml
plugins:
  activity_rewards:
    enabled: true
    config:
      stacking: true
      milestones:
        - id: 1
          metric: messages          # or voice_minutes
          threshold: 100
          roles: ["123456789012345678"]
          remove_roles: ["234567890123456789"]   # e.g. a starter role
        - id: 2
          name: "Voice regular"
          metric: voice_minutes
          threshold: 600            # 10 hours
          roles: ["345678901234567890"]
          channel_id: "456789012345678901"       # optional per-milestone channel
          message_mode: custom                   # post this milestone's own message
          message:
            content: "🎧 {user} has spent **{voice_time}** in voice!"
        - id: 3
          metric: messages
          threshold: 5000
          roles: ["567890123456789012"]
          announce: false                        # award silently
      announcement:
        enabled: true
        destination: current      # channel | current | dm
        channel_id: "678901234567890123"
        content: "🎉 {user} just reached **{milestone}**!"
      message_cooldown_seconds: 30
      min_message_length: 0
      ignored_channels: []
      ignored_roles: []
      voice_require_others: true
      voice_ignore_muted: true
      voice_ignore_afk: true
```

| Field | Description |
|-------|-------------|
| `stacking` | `true` (default): members keep every milestone role they earn. `false`: only the highest reached milestone's roles are kept on each track (messages and voice are separate ladders). |
| `milestones[].metric` / `threshold` | Messages sent, or minutes in voice, needed to reach the milestone. |
| `milestones[].roles` / `remove_roles` | Up to 10 roles each to grant / take away on reaching it. |
| `milestones[].announce` | `false` awards the milestone silently. |
| `milestones[].channel_id` | Post this milestone's announcement here instead of the default destination. |
| `milestones[].message_mode` | `default` uses the shared announcement; `custom` uses the milestone's own `message`. |
| `announcement.enabled` | Whether milestones using the default message announce at all. Milestones with a custom message still post. |
| `announcement.destination` | `channel`: always the announcement channel. `current`: where the member was active (their message's channel, or their voice channel's text chat), falling back to `channel_id`. `dm`: the member's DMs. |
| `message_cooldown_seconds` | Only one message per member counts in this window (0 = every message). |
| `min_message_length` | Ignore short messages. Messages with attachments or stickers always count. |
| `ignored_channels` / `ignored_roles` | Activity in these channels (or their categories) / from members with these roles never counts. |
| `voice_require_others` | Only count voice time while another person is in the channel. |
| `voice_ignore_muted` | Don't count time while muted or deafened (self or server). |
| `voice_ignore_afk` | Don't count time in the server's AFK channel. |

### Placeholders

On top of the usual welcomer placeholders (`{user}`, `{user_display}`, `{guild}`, `{member_count}`, ...):

| Token | Meaning |
|-------|---------|
| `{milestone}` | The milestone's label, or its requirement (e.g. `1,000 messages`) |
| `{milestone_requirement}` | `1,000 messages` / `10 hours in voice` |
| `{messages}` | The member's counted messages |
| `{voice_time}` / `{voice_hours}` | The member's counted voice time, e.g. `12h 30m` / `12.5` |
| `{reward_roles}` | Mentions of the roles granted (never pinged) |
| `{next_milestone}` | The next milestone on the same track, if any |

Announcements only ever ping the member who reached the milestone.

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/rewards progress [user]` | `can_view` | Progress bars to the next milestone on each track, and leaderboard rank |
| `/rewards milestones` | `can_view` | Every milestone, its rewards, and which you've reached |
| `/rewards top [track]` | `can_view` | Top 10 by messages or voice time |
| `/rewards sync` | `can_sync` | Re-apply every milestone role you've earned |
| `/rewards adjust <user> <track> <amount>` | `can_manage` | Add to (or subtract from) a member's progress; awards silently |
| `/rewards reset <user>` | `can_manage` | Wipe a member's progress and remove their milestone roles |

`can_view` and `can_sync` are granted to the built-in **Member** role, `can_manage` to **Admin**.

## Behavior

- Progress is tracked by this plugin itself (not the Stats plugin), starting when the plugin is enabled
  with at least one milestone. The dashboard's **Import from Server Stats** raises every member's
  progress to their recorded Server Stats history and silently applies any roles now earned.
- Voice time is sampled every minute, so every rule (muted, alone, AFK) applies as it changes mid-call.
- Each milestone is awarded once. If several are reached at once (e.g. new milestones added below a
  member's progress), roles for all of them are applied but only the highest one per track is announced.
- Lowering a member's progress with `/rewards adjust` doesn't take roles back; use `/rewards reset`.

## Requirements

- The bot needs **Manage Roles**, and each reward role must sit below the bot's highest role.
