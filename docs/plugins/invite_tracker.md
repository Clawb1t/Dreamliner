# Invite Tracker plugin

See who invited whom: every join is matched to the invite it came through, so members get an invite
count (with fake and rejoin detection), there's a leaderboard, and staff can look up who invited anyone.
Tracked links record where members came from and can give them roles, join and leave messages can name
the inviter, the dashboard shows analytics, and a join burst can alert staff or pause invites.

There are **no rewards for invite counts**. Discord's Platform Manipulation Policy prohibits invite
rewards, so counts never give roles, coins or anything else. The only roles involved are a tracked
link's roles, given for joining *through* that link (they record where someone came from and don't
reward the inviter).

Everything is free. The only limits are hard caps (50 tracked links per server, 5 roles per link).

## Configuration

Dashboard-managed: the Invite Tracker page on the website covers settings, the leaderboard, member
lookups, tracked links, analytics and raid pausing.

```yaml
plugins:
  invite_tracker:
    enabled: true
    config:
      log_channel_id: "123456789012345678"
      ignore_bots: true
      blacklist:
        user_ids: []
        role_ids: []
      count_on: join              # or verified (wait for Passport)
      passport:
        pending_timeout_hours: 72
      fake:
        min_account_age_days: 7
        rejoin_policy: fake        # count | fake | ignore
        quick_leave_minutes: 0     # 0 = off
        quick_leave_as: left       # left | fake
      join_message:
        enabled: true
        channel_id: "234567890123456789"
        message:
          content: "{user} joined, invited by **{inviter_name}** ({invites} invites)"
        unknown_message:
          content: "{user} joined via {join_source}"
      leave_message:
        enabled: true
        channel_id: "234567890123456789"
        message:
          content: "{user_name} left. They were invited by **{inviter_name}** ({invites} invites)"
      leaderboard:
        show_left: true
        show_fake: true
      raid:
        enabled: true
        threshold_joins: 10
        window_seconds: 60
        action: alert              # alert | delete_invite | pause_all
        pause_minutes: 60
        alert_role_id: "345678901234567890"
      retention_days: 365
```

| Field | Description |
|-------|-------------|
| `log_channel_id` | A log entry for every tracked join and leave, plus raid alerts. |
| `ignore_bots` | Bots added to the server count as fake (`bot`). |
| `blacklist.user_ids` / `role_ids` | Joins by (or invites from) these members, and invites from members with these roles, count as fake (`blacklist`). |
| `count_on` | `join`: a join counts straight away. `verified`: it's pending until the member passes Passport. |
| `passport.pending_timeout_hours` | A pending join still unverified after this long counts as fake (`unverified`). |
| `fake.min_account_age_days` | Accounts younger than this count as fake (`account_age`). 0 turns it off. |
| `fake.rejoin_policy` | A member joining again: `count` counts it, `fake` counts it as fake (`rejoin`), `ignore` doesn't count it at all. |
| `fake.quick_leave_minutes` / `quick_leave_as` | Members who leave within this many minutes count as a normal leave (`left`) or as fake (`quick_leave`). |
| `join_message.message` | Posted when the inviter is known. |
| `join_message.unknown_message` | Posted for the vanity URL, tracked links, bot invites and unknown invites. |
| `leave_message.message` | Posted when someone leaves. |
| `leaderboard.show_left` / `show_fake` | Show the left and fake counts on the leaderboard. |
| `raid.*` | Burst detection: `threshold_joins` joins through one invite within `window_seconds`. |
| `raid.action` | `alert` posts in the log channel; `delete_invite` also deletes that invite; `pause_all` also pauses every invite for `pause_minutes` (15 minutes to 24 hours). |
| `retention_days` | Joins older than this (30 to 730 days) are folded into daily analytics totals and stop counting. |

### Placeholders

On top of the usual welcomer placeholders (`{user}`, `{user_name}`, `{user_display}`, `{guild}`, ...):

| Token | Meaning |
|-------|---------|
| `{inviter}` | The inviter's mention (never pinged), or `someone` |
| `{inviter_name}` / `{inviter_id}` | The inviter's name and ID |
| `{invites}` | The inviter's total invites |
| `{invites_regular}` / `{invites_left}` / `{invites_fake}` / `{invites_bonus}` | The parts of that total |
| `{invite_code}` | The invite code used |
| `{invite_link_name}` | The tracked link's name, if it was one |
| `{join_source}` | e.g. `an invite from Sam`, `the vanity URL`, `a tracked link: Twitter bio`, `an unknown invite`, `a bot invite` |
| `{join_count}` | How many times this member has joined |
| `{account_age}` | How old the member's account is, e.g. `3 days` |

Join and leave messages only ever ping the member who joined.

## Counting

A member's total is **regular − left − fake + bonus**, always worked out from the stored joins:

- **Regular**: every join through their invite that isn't waiting on Passport.
- **Left**: a counted join whose member has since left.
- **Fake**: a join counted as fake, for one of the reasons above (`self` is someone joining through their own invite).
- **Bonus**: manual adjustments from `/invites bonus` or the dashboard.

Resets are soft: joins before the reset stop counting (and bonuses are cleared), but the join history and
analytics stay.

## Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/invites count [user]` | `can_view` (`can_view_others` for someone else) | Someone's invite counts and leaderboard rank |
| `/invites leaderboard [page]` | `can_view` | Top inviters, as an image |
| `/invites who <user>` | `can_view` (`can_view_others` for someone else) | Who invited a member, and how |
| `/invites invited [user] [page]` | `can_view` (`can_view_others` for someone else) | The members someone invited, and whether each one counts |
| `/invites codes [user]` | `can_view` (`can_view_others` for someone else) | Someone's active invite codes and their uses |
| `/invites bonus add\|remove <user> <amount>` | `can_manage` | Adjust someone's invites by hand |
| `/invites reset user <user>` / `reset all` | `can_manage` | Soft-reset one member, or everyone (asks to confirm) |
| `/invites sync` | `can_manage` | Re-read the server's invites from Discord |
| `/invites links list\|create\|delete` | `can_manage` | Tracked links |
| `/invites raid pause [minutes]\|resume\|status` | `can_raid` | Pause or resume every invite |
| **Who invited** (user context menu) | `can_view_others` | Who invited that member |

`can_view` and `can_view_others` are granted to the built-in **Member** role, `can_raid` to
**Moderator**, and `can_manage` to **Admin**.

## Behavior

- Joins are matched by comparing the server's invite uses before and after each join, one join at a
  time per server. A single-use invite that vanished counts too. When several invites go up at once
  (or during a burst of joins, or before the cache is ready after a restart), the join is **unknown**.
- Tracked links are invites created by Dreamliner, so they credit nobody; joins through them are
  recorded against the link instead. Deleting a link deletes the Discord invite but keeps its stats.
- With `count_on: verified`, the join message and the link's roles wait until the member passes Passport.
- Pausing uses Discord's own "pause invites" (up to 24 hours), so it shows in the server settings too.

## Requirements

- **Manage Server**, to read invites (without it every join is unknown) and to pause invites.
- **Create Invite** in a tracked link's channel.
- **Manage Roles** for tracked-link roles, which must sit below the bot's highest role and carry no
  staff permissions.
