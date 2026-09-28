# Booster Roles plugin

Reward server boosters with roles for how long they've been continuously boosting the server
(e.g. a role at 1 month, another at 3 months, another at 1 year), how many boosts they've given
(e.g. a role for 2 boosts), or both.

## Configuration

Dashboard-managed, like Autodelete and Persist — configure tiers on the website's config editor.

```yaml
plugins:
  booster_roles:
    enabled: true
    config:
      stacking: false
      tiers:
        - enabled: true
          name: "Booster"
          role_id: "123456789012345678"
          duration_days: 0
        - enabled: true
          name: "Booster (3 months)"
          role_id: "234567890123456789"
          duration_days: 90
        - enabled: true
          name: "Booster (1 year)"
          role_id: "345678901234567890"
          duration_days: 365
        - enabled: true
          name: "Double booster"
          role_id: "456789012345678901"
          requirement: boosts
          boost_count: 2
```

| Field | Description |
|-------|-------------|
| `stacking` | If `true`, boosters keep every tier role they've earned. If `false` (default), only the highest tier of each kind (duration and boost count) they currently qualify for is kept, and lower tier roles are removed as they move up. |
| `tiers` | List of tiers (see below) |
| `enabled` | Turn a tier on/off without deleting it |
| `name` | Optional label shown in the dashboard and `/booster roles` |
| `role_id` | Role granted once a booster reaches this tier |
| `requirement` | `duration` (default): earned by days of boosting. `boosts`: earned by boosts given |
| `duration_days` | Duration tiers: continuous boosting days required (`0` = immediately on boosting) |
| `boost_count` | Boost-count tiers: boosts the member must have given in their current boosting streak (1 to 100) |

Grant `can_view` and `can_recheck` to a Dreamliner Role on the dashboard's **Roles** page (or
`/permissions role grant`) — see [permissions.md](../permissions.md). Both are granted to the
built-in **Member** role by default, so every member can use these commands out of the box.

## Commands

| Command | Permission | Description |
|---------|------------|--------------|
| `/booster roles` | `can_view` | List configured tiers, and how close you are to each one |
| `/booster recheck` | `can_recheck` | Immediately recheck your own boosting against the tiers and apply any role change |

## Behavior

- Boost duration is measured from Discord's `premiumSince` timestamp — how long the member has
  been *continuously* boosting. Un-boosting and re-boosting resets it.
- When a member starts or stops boosting, their tier roles are updated immediately.
- Because tier eligibility also changes just from time passing, the bot re-checks every currently
  boosting member across all guilds with this plugin enabled every 15 minutes.
- A member who stops boosting loses every tier role from this plugin.

## Boost counting

Discord's API doesn't tell bots how many boosts a member has given (only when they started
boosting), so boost-count tiers count the announcements Discord posts in the server's system
channel every time someone boosts:

- Each announcement adds its boosts (Discord includes the number when someone boosts more than
  once at a time) to the booster's count, and their roles update right away.
- Only boosts from the member's current streak count. Stopping boosting entirely resets the count,
  and every current booster counts as at least 1 boost.
- Removing one of several boosts isn't visible to bots, so a count only goes down when the member
  stops boosting entirely.
- Announcements must be on: in Discord, **Server Settings, Engagement, System Messages**, pick a
  channel and turn on "Send a message when someone boosts this server".
- **Count past boosts** on the dashboard (shown once a boost-count tier exists) reads earlier
  announcements in the system channel, stopping at the oldest current boosting streak (at most
  20,000 messages), and rebuilds every current booster's count. It needs View Channel and Read
  Message History there, and can run once every 10 minutes.

## Requirements

- The bot needs **Manage Roles**, and each tier's role must sit below the bot's highest role.
